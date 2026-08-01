import {
  replacePlaylistTracks,
  type PlaylistTrackInput,
} from "@/lib/db/repo/playlists";
import { upsertArtist } from "@/lib/db/repo/artists";
import { saveSimilarArtists } from "@/lib/db/repo/similarity";
import { saveArtistTags } from "@/lib/db/repo/tags";
import { savePopularity } from "@/lib/db/repo/recordings";
import { selectByDepth } from "@/lib/engine/obscurity";
import { blendedSimilarity, tagOverlap } from "@/lib/engine/scoring";
import type {
  EngineArtist,
  EngineTrack,
  ObscurityBand,
  StyleConstraints,
} from "@/lib/engine/types";
import { buildBlend, buildDeepCuts, buildFamous } from "@/lib/engine/introduceMe";
import { generateStylePlaylist } from "@/lib/engine/stylePlaylist";
import { seedFromString } from "@/lib/engine/random";
import { catalog, popularity, similarityProviders, tags } from "@/lib/providers/registry";
import type { ArtistRef, ScoredArtistRef } from "@/lib/providers/types";
import type { JobContext } from "./generationJobs";
import { loadAlbumTracks, loadCatalogTracks, loadTopTracks } from "./trackPool";

/**
 * The only module that knows about providers, the engine and the database at
 * once. Everything above it deals in playlists; everything below deals in
 * either data or pure selection.
 */

export interface GenerationResult {
  warnings: string[];
  trackCount: number;
}

function toTrackInputs(tracks: readonly EngineTrack[]): PlaylistTrackInput[] {
  return tracks.map((track) => ({
    title: track.title,
    artistNames: track.artistNames,
    album: track.album,
    isrc: track.isrc,
    durationMs: track.durationMs,
    year: track.year,
    reason: track.reason,
  }));
}

/** Persists what we learned about an artist so the next generation is cheaper. */
function rememberArtist(detail: {
  mbid: string;
  name: string;
  disambiguation?: string;
  country?: string;
  beginYear?: number;
  endYear?: number;
  tags?: Record<string, number>;
}): string {
  const artistId = upsertArtist(detail);
  if (detail.tags && Object.keys(detail.tags).length > 0) {
    saveArtistTags(artistId, detail.tags, catalog.id, licenseForTags());
  }
  return artistId;
}

function licenseForTags() {
  // MusicBrainz tags are CC BY-NC-SA until a MetaBrainz supporter tier covers
  // them; the provider decides, we just mirror its judgement into the row.
  return process.env.METABRAINZ_COMMERCIAL_LICENSE === "true"
    ? ("licensed" as const)
    : ("noncommercial" as const);
}

// --- Introduce me --------------------------------------------------------

export interface IntroduceInput {
  playlistId: string;
  artistMbid: string;
  artistName: string;
  submode: "famous" | "deep" | "blend";
  constraints: StyleConstraints;
}

function persist(
  playlistId: string,
  result: { tracks: EngineTrack[]; warnings: string[] },
  extraWarnings: string[],
): GenerationResult {
  replacePlaylistTracks(playlistId, toTrackInputs(result.tracks));
  return {
    warnings: [...extraWarnings, ...result.warnings],
    trackCount: result.tracks.length,
  };
}

export async function runIntroduce(
  input: IntroduceInput,
  ctx: JobContext,
): Promise<GenerationResult> {
  const { artistMbid, submode, constraints } = input;
  const warnings: string[] = [];

  ctx.progress(0, 4, `Looking up ${input.artistName}…`);

  const detail = await catalog.getArtist(artistMbid);
  if (!detail) {
    return { warnings: ["That artist could not be found."], trackCount: 0 };
  }

  const artistKey = detail.data.mbid;
  const artistRef: ArtistRef = { mbid: detail.data.mbid, name: detail.data.name };
  rememberArtist({ ...detail.data, tags: detail.data.tags });

  const engineArtist: EngineArtist = {
    key: artistKey,
    mbid: detail.data.mbid,
    name: detail.data.name,
    tagAffinity: detail.data.tags,
    tracks: [],
  };

  if (submode === "famous") {
    ctx.progress(1, 4, "Finding their best-known tracks…");
    const pool = await loadTopTracks(artistRef, artistKey, 60);

    if (pool.tracks.length === 0) {
      ctx.progress(2, 4, "Falling back to their catalogue…");
      const fallback = await loadCatalogTracks(artistMbid, artistKey);
      engineArtist.tracks = fallback.tracks;
      warnings.push(
        `No popularity data was available for ${detail.data.name}.`,
      );
    } else {
      engineArtist.tracks = pool.tracks;
    }

    ctx.progress(3, 4, "Building the playlist…");
    const result = buildFamous({ artist: engineArtist, constraints });
    return persist(input.playlistId, result, warnings);
  }

  if (submode === "deep") {
    ctx.progress(1, 4, "Reading their discography…");
    const top = await loadTopTracks(artistRef, artistKey, 50);

    const albums = await loadAlbumTracks(artistRef, artistKey, {
      onProgress: (done, total) =>
        ctx.progress(1 + done / Math.max(1, total), 4, `Reading album ${done + 1} of ${total}…`),
    });

    let tracks = albums.tracks;
    if (tracks.length === 0) {
      const fallback = await loadCatalogTracks(artistMbid, artistKey, 8);
      tracks = fallback.tracks;
      if (tracks.length > 0) {
        warnings.push(
          "Album popularity data was unavailable, so these are album tracks rather than ranked deep cuts.",
        );
      }
    }

    engineArtist.tracks = tracks;
    ctx.progress(3, 4, "Picking the deep cuts…");

    const result = buildDeepCuts({
      artist: engineArtist,
      constraints,
      // Anything in the top tracks is by definition not a deep cut. Both the
      // key and the normalised title are excluded, because the same song often
      // has different ids across a single/album pairing.
      excludeKeys: new Set([
        ...top.tracks.map((track) => track.key),
        ...top.tracks.slice(0, 15).map((track) => track.titleNorm),
      ]),
    });
    return persist(input.playlistId, result, warnings);
  }

  // Blend
  ctx.progress(1, 6, "Finding similar artists…");
  const similar = await findSimilarArtists(
    artistRef,
    10,
    constraints.obscurity,
    detail.data.tags,
    ctx,
  );

  if (similar.length === 0) {
    warnings.push(`No similar artists were found for ${detail.data.name}.`);
  }

  const seedPool = await loadTopTracks(artistRef, artistKey, 40);
  engineArtist.tracks = seedPool.tracks.length
    ? seedPool.tracks
    : (await loadCatalogTracks(artistMbid, artistKey, 4)).tracks;

  const contributors: { artist: EngineArtist; score: number }[] = [];
  for (const [index, neighbour] of similar.entries()) {
    ctx.progress(2 + index, 2 + similar.length + 1, `Adding ${neighbour.name}…`);

    const key = neighbour.mbid ?? neighbour.name;
    const pool = await loadTopTracks(
      { mbid: neighbour.mbid, name: neighbour.name },
      key,
      25,
    );
    if (pool.tracks.length === 0) continue;

    contributors.push({
      artist: {
        key,
        mbid: neighbour.mbid,
        name: neighbour.name,
        tagAffinity: {},
        tracks: pool.tracks,
      },
      score: neighbour.score,
    });
  }

  ctx.progress(2 + similar.length, 2 + similar.length + 1, "Building the blend…");

  const result = buildBlend({
    seedArtist: engineArtist,
    similar: contributors,
    constraints,
  });
  return persist(input.playlistId, result, warnings);
}

/**
 * Merges the similarity providers in preference order, keeping the best score
 * per artist. ListenBrainz first (CC0, session-based); Deezer only fills gaps.
 *
 * The merged list is then sliced by depth rather than taken from the top —
 * see selectByDepth. Asking for a wide candidate pool is what makes that
 * possible, so the per-provider limit is far larger than the final count.
 */
async function findSimilarArtists(
  artist: ArtistRef,
  limit: number,
  band: ObscurityBand,
  seedTags: Record<string, number>,
  ctx: JobContext,
): Promise<ScoredArtistRef[]> {
  const merged = new Map<string, ScoredArtistRef>();

  for (const provider of similarityProviders) {
    if (merged.size >= limit * 6) break;
    try {
      const result = await provider.getSimilarArtists(artist, 100);
      if (artist.mbid) {
        const artistId = upsertArtist({ mbid: artist.mbid, name: artist.name });
        saveSimilarArtists(
          artistId,
          result.data,
          result.source,
          result.licenseClass,
          undefined,
        );
      }
      for (const neighbour of result.data) {
        const key = (neighbour.mbid ?? neighbour.name).toLowerCase();
        const existing = merged.get(key);
        if (!existing || neighbour.score > existing.score) {
          merged.set(key, neighbour);
        }
      }
    } catch {
      // A similarity source with no SLA failing is expected; the next one, or
      // an empty list, is a valid outcome.
    }
  }

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];

  // Genre-check the strongest candidates. Capped because each lookup costs a
  // MusicBrainz request at 1/s; the rest keep their raw similarity, which only
  // matters if the checked set turns out too thin to fill the playlist.
  const CHECK_LIMIT = 24;
  const toCheck = ranked.slice(0, CHECK_LIMIT).filter((a) => a.mbid);

  const rescored: ScoredArtistRef[] = [];
  for (const [index, candidate] of toCheck.entries()) {
    ctx.progress(index, toCheck.length, `Checking ${candidate.name}…`);
    try {
      const detail = await catalog.getArtist(candidate.mbid as string);
      const overlap = detail ? tagOverlap(seedTags, detail.data.tags) : 0;
      rescored.push({
        ...candidate,
        score: blendedSimilarity(candidate.score, overlap, band),
      });
      if (detail) rememberArtist({ ...detail.data, tags: detail.data.tags });
    } catch {
      rescored.push(candidate);
    }
  }

  const pool = rescored.length >= limit ? rescored : ranked;
  pool.sort((a, b) => b.score - a.score);

  return selectByDepth(pool, band, limit);
}

// --- Style playlists -----------------------------------------------------

export interface StyleInput {
  playlistId: string;
  seeds: { tag: string; weight: number }[];
  constraints: StyleConstraints;
}

/** Below this many artists a tag is too thin to build from on its own. */
const THIN_TAG_THRESHOLD = 25;

export async function runStyle(
  input: StyleInput,
  ctx: JobContext,
): Promise<GenerationResult> {
  const warnings: string[] = [];
  const seeds = input.seeds.slice();

  ctx.progress(0, 10, "Finding artists…");

  const artistsByKey = new Map<string, EngineArtist>();

  for (const [index, seed] of seeds.entries()) {
    ctx.progress(index, seeds.length + 6, `Finding ${seed.tag} artists…`);

    const found = await tags.getArtistsForTag(seed.tag, 60);
    for (const artist of found.data) {
      addArtist(artistsByKey, artist, seed.tag, seed.weight);
    }

    // A thin tag gets widened with its nearest neighbours, discounted so the
    // original request still dominates the result.
    if (found.data.length < THIN_TAG_THRESHOLD) {
      try {
        const related = await tags.getSimilarTags(seed.tag, 4);
        for (const neighbour of related.data.slice(0, 3)) {
          const extra = await tags.getArtistsForTag(neighbour.tag, 40);
          for (const artist of extra.data) {
            addArtist(artistsByKey, artist, seed.tag, seed.weight * 0.5);
          }
        }
        if (related.data.length > 0) {
          warnings.push(
            `"${seed.tag}" is a narrow tag, so closely related styles were included too.`,
          );
        }
      } catch {
        // Tag expansion is a bonus; its absence is not worth reporting.
      }
    }
  }

  const candidates = [...artistsByKey.values()];
  if (candidates.length === 0) {
    return {
      warnings: ["No artists were found for those styles."],
      trackCount: 0,
    };
  }

  // Only load tracks for artists likely to be used: each lookup is several
  // rate-limited calls, and loading the whole pool would take minutes.
  const needed = Math.min(
    candidates.length,
    Math.ceil((input.constraints.targetLength / input.constraints.maxPerArtist) * 2),
  );
  const shortlist = candidates
    .sort((a, b) => scoreOf(b, seeds) - scoreOf(a, seeds))
    .slice(0, needed);

  for (const [index, artist] of shortlist.entries()) {
    ctx.progress(
      seeds.length + index,
      seeds.length + shortlist.length + 1,
      `Loading ${artist.name}… (${index + 1}/${shortlist.length})`,
    );

    const ref: ArtistRef = { mbid: artist.mbid, name: artist.name };
    const pool = await loadTopTracks(ref, artist.key, 25);
    artist.tracks = pool.tracks;

    if (pool.ranked && popularity) {
      const artistPopularity = await popularity.getArtistPopularity(ref).catch(() => null);
      if (artistPopularity) {
        artist.popularity = artistPopularity.data;
        if (artist.mbid) {
          const artistId = upsertArtist({ mbid: artist.mbid, name: artist.name });
          savePopularity({
            entityType: "artist",
            entityId: artistId,
            scoreRaw: artistPopularity.data,
            scoreNorm: 0,
            source: artistPopularity.source,
            licenseClass: artistPopularity.licenseClass,
          });
        }
      }
    }
  }

  ctx.progress(
    seeds.length + shortlist.length,
    seeds.length + shortlist.length + 1,
    "Building the playlist…",
  );

  const result = generateStylePlaylist({
    seeds,
    artists: shortlist.filter((artist) => artist.tracks.length > 0),
    constraints: input.constraints,
  });

  replacePlaylistTracks(input.playlistId, toTrackInputs(result.tracks));

  return {
    warnings: [...warnings, ...result.warnings],
    trackCount: result.tracks.length,
  };
}

function addArtist(
  target: Map<string, EngineArtist>,
  artist: ScoredArtistRef,
  tag: string,
  weight: number,
): void {
  const key = artist.mbid ?? artist.name.toLowerCase();
  const existing = target.get(key);
  const affinity = artist.score * weight;

  if (existing) {
    existing.tagAffinity[tag] = Math.max(existing.tagAffinity[tag] ?? 0, affinity);
    return;
  }

  target.set(key, {
    key,
    mbid: artist.mbid,
    name: artist.name,
    tagAffinity: { [tag]: affinity },
    tracks: [],
  });
}

function scoreOf(artist: EngineArtist, seeds: { tag: string; weight: number }[]): number {
  return seeds.reduce(
    (sum, seed) => sum + (artist.tagAffinity[seed.tag] ?? 0) * seed.weight,
    0,
  );
}

export function seedFor(parts: string[]): number {
  return seedFromString(parts.join("|"));
}
