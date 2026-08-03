import {
  replacePlaylistTracks,
  type PlaylistTrackInput,
} from "@/lib/db/repo/playlists";
import { upsertArtist } from "@/lib/db/repo/artists";
import { saveSimilarArtists } from "@/lib/db/repo/similarity";
import { saveArtistTags } from "@/lib/db/repo/tags";
import { savePopularity } from "@/lib/db/repo/recordings";
import {
  consensusProfile,
  matchedSeedCount,
  type ConsensusProfile,
  type SeedProfile,
} from "@/lib/engine/consensus";
import { selectByDepth } from "@/lib/engine/obscurity";
import {
  rankByGenreThenSimilarity,
  tagCosine,
  tagSpecificity,
} from "@/lib/engine/scoring";
import type {
  EngineArtist,
  EngineTrack,
  ObscurityBand,
  StyleConstraints,
} from "@/lib/engine/types";
import { buildBlend, buildDeepCuts, buildFamous } from "@/lib/engine/introduceMe";
import { buildDiscovery } from "@/lib/engine/discover";
import { generateStylePlaylist } from "@/lib/engine/stylePlaylist";
import { passesFilters } from "@/lib/engine/titleFilters";
import { seedFromString } from "@/lib/engine/random";
import { catalog, popularity, similarityProviders, tags } from "@/lib/providers/registry";
import type { ArtistRef, ScoredArtistRef } from "@/lib/providers/types";
import { normalizeArtistName } from "@/lib/text";
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

// --- Pool sizing ---------------------------------------------------------

/**
 * Everything below exists because the honest failure mode of this app is a
 * playlist that stops short. Asking for 200 tracks and getting 140 is the
 * complaint these numbers answer, so each pool is sized from the request
 * rather than fixed, and deliberately overshoots: between artists the
 * popularity provider cannot resolve, title filters and cross-artist dedupe, a
 * meaningful share of any shortlist yields nothing at all.
 */

/** Distinct artists a playlist of this shape needs before any losses. */
function artistsNeededFor(targetLength: number, maxPerArtist: number): number {
  return Math.ceil(targetLength / Math.max(1, maxPerArtist));
}

/**
 * Hard ceiling on artists resolved in one generation. Each costs a rate-limited
 * round trip, so this is what stops a 200-track request turning into a
 * ten-minute job; past it we would rather return a slightly shorter playlist
 * than leave someone watching a progress bar.
 */
const MAX_SHORTLIST = 260;

/**
 * Stop loading once the pool could fill the playlist this many times over.
 * Above 1 so the engine still has something to choose between — sampling from a
 * pool that exactly fits makes the obscurity band meaningless.
 */
const POOL_HEADROOM = 1.6;

/**
 * Albums to read for a track target, assuming a couple of usable deep cuts
 * each. The ceiling stops a long request walking a 200-record discography one
 * rate-limited call at a time.
 */
function albumsNeededFor(targetLength: number): number {
  return Math.min(40, Math.max(12, Math.ceil(targetLength / 2)));
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
    const want = constraints.targetLength;
    const pool = await loadTopTracks(artistRef, artistKey, Math.max(60, want));

    let supplement: EngineTrack[] = [];

    if (pool.tracks.length === 0) {
      ctx.progress(2, 4, "Falling back to their catalogue…");
      const fallback = await loadCatalogTracks(artistMbid, artistKey);
      engineArtist.tracks = fallback.tracks;
      warnings.push(
        `No popularity data was available for ${detail.data.name}.`,
      );
    } else {
      engineArtist.tracks = pool.tracks;

      // The chart endpoint stops at 100 tracks however many are asked for, so a
      // longer request can only be filled from the albums. buildFamous keeps
      // the two apart — see its `supplement` docs.
      if (pool.tracks.length < want) {
        ctx.progress(2, 4, "Looking through their albums…");
        const albums = await loadAlbumTracks(artistRef, artistKey, {
          maxAlbums: albumsNeededFor(want - pool.tracks.length),
          onProgress: (done, total) =>
            ctx.progress(2 + done / Math.max(1, total), 4, `Reading album ${done + 1} of ${total}…`),
        });
        supplement = albums.tracks;
      }
    }

    ctx.progress(3, 4, "Building the playlist…");
    const result = buildFamous({ artist: engineArtist, constraints, supplement });
    return persist(input.playlistId, result, warnings);
  }

  if (submode === "deep") {
    ctx.progress(1, 4, "Reading their discography…");
    const top = await loadTopTracks(artistRef, artistKey, 50);

    const albums = await loadAlbumTracks(artistRef, artistKey, {
      maxAlbums: albumsNeededFor(constraints.targetLength),
      onProgress: (done, total) =>
        ctx.progress(1 + done / Math.max(1, total), 4, `Reading album ${done + 1} of ${total}…`),
    });

    let tracks = albums.tracks;
    if (tracks.length === 0) {
      const fallback = await loadCatalogTracks(
        artistMbid,
        artistKey,
        albumsNeededFor(constraints.targetLength),
      );
      tracks = fallback.tracks;
      if (tracks.length > 0) {
        warnings.push(
          "Album popularity data was unavailable, so these are album tracks rather than ranked deep cuts.",
        );
      }
    }

    engineArtist.tracks = tracks;
    ctx.progress(3, 4, "Picking the deep cuts…");

    // Two per album is the ideal, but an artist with twelve records cannot fill
    // a 200-track request that way. Rather than silently returning a quarter of
    // what was asked for, dig further into each album — capped, because past
    // about six the "deep cut" claim collapses into "the album, minus singles".
    const albumCount = new Set(
      tracks.map((track) => track.albumKey ?? track.album ?? "unknown"),
    ).size;
    const maxPerAlbum = Math.min(
      6,
      Math.max(2, Math.ceil(constraints.targetLength / Math.max(1, albumCount))),
    );

    const result = buildDeepCuts({
      artist: engineArtist,
      constraints,
      maxPerAlbum,
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

  // The seed takes SEED_SHARE of the playlist, so the neighbours only have to
  // cover the rest — sized from the request rather than the fixed 10 this used
  // to ask for, which capped a blend at roughly 22 tracks whatever was chosen.
  //
  // Asked for with margin: requesting exactly enough neighbours means every one
  // that the popularity provider cannot resolve comes straight off the end of
  // the playlist. loadContributors stops early once it has enough, so the
  // margin costs nothing when the artists do resolve.
  //
  // Sized against the WHOLE playlist rather than the neighbours' nominal share,
  // because buildBlend hands the seed's unused slots to the neighbours when the
  // seed artist has too small a catalogue to fill its own share.
  const neighboursWanted = Math.ceil(
    artistsNeededFor(constraints.targetLength, constraints.maxPerArtist) * 1.5,
  );

  const similar = await findSimilarArtists(
    artistRef,
    neighboursWanted,
    constraints.obscurity,
    detail.data.tags,
    ctx,
  );

  if (similar.length === 0) {
    warnings.push(`No similar artists were found for ${detail.data.name}.`);
  }

  const seedWanted = Math.ceil(constraints.targetLength * SEED_SHARE);
  const seedPool = await loadTopTracks(
    artistRef,
    artistKey,
    Math.max(40, seedWanted * 2),
  );
  engineArtist.tracks = seedPool.tracks.length
    ? seedPool.tracks
    : (await loadCatalogTracks(artistMbid, artistKey, 4)).tracks;

  // What the seed can really contribute, which is what the neighbours have to
  // make up the difference on. Counted here rather than assumed from
  // SEED_SHARE, so an artist with a thin catalogue widens the neighbour search
  // instead of shortening the playlist.
  const seedUsable = engineArtist.tracks.filter((track) =>
    passesFilters(track, constraints),
  ).length;

  const contributors = await loadContributors(similar, constraints, ctx, {
    label: (name) => `Adding ${name}…`,
    // Neighbours only fill the slots the seed leaves, so count against those
    // rather than against the whole playlist — otherwise the loop never
    // reaches its target and the early stop never fires.
    capacityTarget: Math.ceil(
      (constraints.targetLength - Math.min(seedWanted, seedUsable)) * POOL_HEADROOM,
    ),
  });

  const result = buildBlend({
    seedArtist: engineArtist,
    similar: contributors,
    constraints,
    seedShare: SEED_SHARE,
  });
  return persist(input.playlistId, result, warnings);
}

/** Share of a blend reserved for the artist being introduced. */
const SEED_SHARE = 0.35;

/**
 * Resolves similar artists into track pools, stopping as soon as enough tracks
 * are in hand. Shared by the blend and discovery modes, which differ in what
 * they do with the result rather than in how they gather it.
 */
async function loadContributors(
  similar: readonly ScoredArtistRef[],
  constraints: StyleConstraints,
  ctx: JobContext,
  options: {
    label: (name: string) => string;
    capacityTarget?: number;
    /**
     * Fetch each artist's audience size. Costs nothing extra in practice — the
     * search response that resolved the artist already carried it, so this is a
     * cache hit — but it is only worth carrying where the caller bands on it.
     */
    withPopularity?: boolean;
  } = {
    label: (name) => `Adding ${name}…`,
  },
): Promise<{ artist: EngineArtist; score: number }[]> {
  const capacityTarget =
    options.capacityTarget ?? Math.ceil(constraints.targetLength * POOL_HEADROOM);

  const contributors: { artist: EngineArtist; score: number }[] = [];
  const loadedArtists = new Set<string>();
  let capacity = 0;

  for (const [index, neighbour] of similar.entries()) {
    ctx.progress(index, similar.length + 1, options.label(neighbour.name));

    const ref: ArtistRef = { mbid: neighbour.mbid, name: neighbour.name };
    const key = neighbour.mbid ?? neighbour.name;
    const pool = await loadTopTracks(ref, key, 25);
    if (pool.tracks.length === 0) continue;

    /**
     * Deduplicated on the name the popularity provider came back with, not the
     * one we asked about. Two similarity entries can carry different names and
     * still resolve to the same artist — "Bob Dylan" and "Bob Dylan & The
     * Band" both match Bob Dylan above the fuzzy threshold — and since the
     * per-artist cap works on our keys, both copies survived it and one artist
     * appeared three times in a playlist capped at two.
     */
    const resolved = normalizeArtistName(pool.tracks[0].artistNames[0] ?? neighbour.name);
    if (resolved && loadedArtists.has(resolved)) continue;
    if (resolved) loadedArtists.add(resolved);

    const artistPopularity = options.withPopularity
      ? await popularity?.getArtistPopularity(ref).catch(() => null)
      : null;

    contributors.push({
      artist: {
        key,
        mbid: neighbour.mbid,
        name: neighbour.name,
        tagAffinity: {},
        // Without this the engine had no way to tell one neighbour from
        // another, so coherence could only ever be checked against the seed.
        tags: neighbour.tags,
        popularity: artistPopularity?.data,
        tracks: pool.tracks,
      },
      score: neighbour.score,
    });

    // Count only what this artist can actually contribute after the cap and the
    // filters, so an artist whose catalogue is all live albums doesn't count
    // towards the target and then vanish in the engine.
    const usable = pool.tracks.filter((track) => passesFilters(track, constraints));
    capacity += Math.min(constraints.maxPerArtist, usable.length);
    if (capacity >= capacityTarget) break;
  }

  ctx.progress(similar.length, similar.length + 1, "Building the playlist…");
  return contributors;
}

// --- Discover similar artists --------------------------------------------

export interface DiscoveryInput {
  playlistId: string;
  artistMbid: string;
  artistName: string;
  constraints: StyleConstraints;
}

/** Candidates gathered per seat, so the obscurity band has something to reject. */
const DISCOVERY_OVERSHOOT = 2.5;

/**
 * Every slot goes to someone else. The seed artist is the query, not a
 * contributor — see buildDiscovery for why that is the whole point of the mode.
 */
export async function runDiscover(
  input: DiscoveryInput,
  ctx: JobContext,
): Promise<GenerationResult> {
  const { artistMbid, constraints } = input;
  const warnings: string[] = [];

  ctx.progress(0, 4, `Looking up ${input.artistName}…`);

  const detail = await catalog.getArtist(artistMbid);
  if (!detail) {
    return { warnings: ["That artist could not be found."], trackCount: 0 };
  }

  rememberArtist({ ...detail.data, tags: detail.data.tags });

  const artistRef: ArtistRef = { mbid: detail.data.mbid, name: detail.data.name };

  // Deliberately over-fetched. The obscurity band works by pushing the
  // best-known artists down the order, and that only removes anyone if there
  // are more candidates than seats — load exactly enough and the band becomes
  // decorative.
  const wanted = Math.min(
    MAX_SHORTLIST,
    Math.ceil(
      artistsNeededFor(constraints.targetLength, constraints.maxPerArtist) *
        DISCOVERY_OVERSHOOT,
    ),
  );

  ctx.progress(1, 4, `Finding artists who sound like ${detail.data.name}…`);
  const similar = await findSimilarArtists(
    artistRef,
    wanted,
    constraints.obscurity,
    detail.data.tags,
    ctx,
  );

  if (similar.length === 0) {
    return {
      warnings: [
        `No similar artists were found for ${detail.data.name}. They may be too new or too obscure to have listening data yet.`,
      ],
      trackCount: 0,
    };
  }

  const contributors = await loadContributors(similar, constraints, ctx, {
    label: (name) => `Listening to ${name}…`,
    // Audience size is what the band is applied to — see buildDiscovery.
    withPopularity: true,
    capacityTarget: Math.ceil(constraints.targetLength * DISCOVERY_OVERSHOOT),
  });

  const result = buildDiscovery({
    seedArtistName: detail.data.name,
    seedTags: detail.data.tags,
    similar: contributors,
    constraints,
    // The seed is already excluded upstream, but a similarity provider that
    // returns an artist under a second MBID would slip past that, and one
    // track by the artist you asked to move on from undermines the whole mode.
    excludeArtistKeys: new Set([detail.data.mbid, detail.data.name]),
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

  /**
   * Keyed on the artist's name rather than their MBID, because ListenBrainz
   * returns MBIDs and Deezer does not. Keying on `mbid ?? name` filed the same
   * artist under two keys, and since the engine's per-artist cap works on
   * those keys, both copies survived it — which is how a playlist limited to
   * one track per artist ended up with The Strokes twice.
   */
  const identity = (ref: { name: string }) =>
    normalizeArtistName(ref.name) || ref.name.trim().toLowerCase();

  const seedKey = identity(artist);

  const absorb = (neighbours: readonly ScoredArtistRef[], discount = 1) => {
    for (const neighbour of neighbours) {
      const key = identity(neighbour);
      if (!key || key === seedKey) continue;

      const score = neighbour.score * discount;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...neighbour, score });
        continue;
      }

      // Keep the stronger claim, but never drop an MBID on the floor: the
      // genre cross-check and the second-degree walk both need one.
      merged.set(key, {
        ...existing,
        mbid: existing.mbid ?? neighbour.mbid,
        score: Math.max(existing.score, score),
      });
    }
  };

  const askFor = Math.max(100, limit * 3);

  for (const provider of similarityProviders) {
    if (merged.size >= limit * 6) break;
    try {
      const result = await provider.getSimilarArtists(artist, askFor);
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
      absorb(result.data);
    } catch {
      // A similarity source with no SLA failing is expected; the next one, or
      // an empty list, is a valid outcome.
    }
  }

  ctx.progress(1, 3, "Checking genres…");
  await attachTagProfiles(merged);

  const fitOf = (candidate: ScoredArtistRef) =>
    candidate.tags ? tagCosine(seedTags, candidate.tags) : undefined;

  // ListenBrainz returns about a hundred neighbours per artist, which is short
  // of what a long playlist needs — and after genre filtering it is far
  // shorter, because most of those neighbours turn out to share nothing with
  // the seed but an audience. So the graph is walked one step further.
  //
  // Crucially the walk starts from the best-FITTING neighbours rather than the
  // most co-listened ones. Expanding from a superstar co-listen returns more
  // superstars; expanding from the one genuine jungle artist in the list
  // returns more jungle artists, which is where the underground actually is.
  if (merged.size < limit * 3) {
    const nearest = [...merged.values()]
      .filter((candidate) => candidate.mbid)
      .sort((a, b) => (fitOf(b) ?? 0) - (fitOf(a) ?? 0))
      .slice(0, SECOND_DEGREE_SEEDS);

    for (const [index, near] of nearest.entries()) {
      if (merged.size >= limit * 5) break;
      ctx.progress(index, nearest.length, `Looking beyond ${near.name}…`);
      try {
        const result = await similarityProviders[0].getSimilarArtists(
          { mbid: near.mbid, name: near.name },
          askFor,
        );
        absorb(result.data, near.score * SECOND_DEGREE_DISCOUNT);
      } catch {
        // Same no-SLA reasoning as above.
      }
    }

    await attachTagProfiles(merged);
  }

  const all = [...merged.values()];
  if (all.length === 0) return [];

  const fits = all.map(fitOf);

  // An artist MusicBrainz has no tags for is treated as exactly average rather
  // than as a mismatch. Scoring the unknown at zero would bury the smallest
  // artists, who are the least tagged and the whole point of the exercise;
  // scoring it high would let them outrank verified matches.
  const measured = fits.filter((value): value is number => value !== undefined);
  const meanFit =
    measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 0.5;

  /**
   * Candidates with no measurable genre relationship at all are dropped
   * outright, not merely down-weighted — around half of any co-listening list
   * scores exactly zero against the seed. They only survive if removing them
   * would leave too few artists to build from, in which case a thin playlist
   * of the right kind still beats a full one of the wrong kind, but an empty
   * one beats neither.
   */
  const scored = all.map((candidate, index) => ({
    candidate,
    fit: fits[index] ?? meanFit,
  }));

  const onGenre = scored.filter((entry) => entry.fit > 0);
  const usable = onGenre.length >= limit ? onGenre : scored;

  const ordering = rankByGenreThenSimilarity(
    usable.map((entry) => ({ similarity: entry.candidate.score, fit: entry.fit })),
    band,
  );

  const pool = usable
    .map((entry, index) => ({ ...entry.candidate, score: ordering[index] }))
    .sort((a, b) => b.score - a.score);

  for (const candidate of pool) {
    if (candidate.mbid && candidate.tags) {
      rememberArtist({ mbid: candidate.mbid, name: candidate.name, tags: candidate.tags });
    }
  }

  return selectByDepth(pool, band, limit);
}

/**
 * Attaches genre profiles to every candidate that lacks one, in place.
 *
 * Batched, which is the only reason judging candidates on genre is affordable
 * at all: one artist lookup per candidate would be a second each.
 */
async function attachTagProfiles(merged: Map<string, ScoredArtistRef>): Promise<void> {
  if (!catalog.getTagProfiles) return;

  const needed = [...merged.values()]
    .filter((candidate) => candidate.mbid && !candidate.tags)
    .map((candidate) => candidate.mbid as string);
  if (needed.length === 0) return;

  try {
    const profiles = await catalog.getTagProfiles(needed);
    for (const [key, candidate] of merged) {
      const tags = candidate.mbid ? profiles.data.get(candidate.mbid) : undefined;
      if (tags) merged.set(key, { ...candidate, tags });
    }
  } catch {
    // Ordering falls back to similarity alone, which is the old behaviour.
  }
}

/** How many near neighbours to expand from when the first-degree pool is thin. */
const SECOND_DEGREE_SEEDS = 6;

/** Two steps out is a weaker claim than one, and scores have to reflect that. */
const SECOND_DEGREE_DISCOUNT = 0.7;

// --- Sounds like these songs or albums -----------------------------------

export interface TrackSeedInput {
  /** Every recording id for the song, best first — see ScoredRecordingRef. */
  mbids: string[];
  title: string;
  artistNames: string[];
  artistMbid?: string;
  album?: string;
  albumMbid?: string;
  year?: number;
}

export interface AlbumSeedInput {
  mbid: string;
  title: string;
  artistNames: string[];
  artistMbid?: string;
  year?: number;
}

export interface SoundsLikeInput {
  playlistId: string;
  seedKind: "tracks" | "albums";
  tracks?: TrackSeedInput[];
  albums?: AlbumSeedInput[];
  constraints: StyleConstraints;
}

/** One seed reduced to the ids needed to profile it, whichever kind it was. */
interface SoundsLikeSeed {
  key: string;
  title: string;
  artistNames: string[];
  artistMbid?: string;
  /**
   * For a song, every recording id MusicBrainz has for that ONE song — the
   * single, the album cut, the reissue — of which the similarity index knows
   * some and not others. For an album, a sample of its actual tracklist, which
   * are different songs entirely. `kind` says which, because the two are
   * queried in opposite ways: alternate ids are tried until one answers, where
   * an album's tracks are all asked and the answers pooled.
   */
  kind: "track" | "album";
  recordingMbids: string[];
  albumMbid?: string;
}

/**
 * How much of a seed's profile each layer may contribute.
 *
 * A song is described three times over, at falling resolution: by its own tags,
 * by the record it sits on, and by whoever made it. The song's tags are the
 * only ones that distinguish one track on an album from another, so they lead;
 * the artist's are the most complete and the least specific, so they fill gaps
 * without ever setting the profile's direction. Layered by MAX rather than
 * summed, since the same tag arriving from all three levels is one piece of
 * evidence repeated, not three.
 */
const RECORDING_TAG_WEIGHT = 1;
const ALBUM_TAG_WEIGHT = 0.6;
const ARTIST_TAG_WEIGHT = 0.35;

/**
 * Genre tags the song and album layers must supply before the artist layer is
 * left out of a seed's profile entirely.
 *
 * The artist layer is a gap-filler, and on a record that departs from its
 * author's catalogue it fills the gap with the wrong thing. Lil Yachty's *Let's
 * Start Here* is tagged psychedelic rock, space rock, neo-psychedelia,
 * psychedelic soul and art pop; Lil Yachty the artist is tagged, in full, "hip
 * hop, southern hip hop, trap". Layered in at 0.35 those three land third,
 * fourth and fifth in a profile whose peak is 0.6 — and once specificity is
 * applied "southern hip hop" outranks "psychedelic rock", because the umbrella
 * discount hits the album's tag and not the artist's. The record then recruits
 * rap for a psychedelic playlist, which is precisely what it did.
 *
 * Five is not a fine-tuned number: a record with five genre tags of its own has
 * already said what it is, and one with fewer usually has not.
 */
const OWN_TAGS_ENOUGH = 5;

/** Alternate recording ids profiled per seed song. */
const RECORDING_IDS_PER_SEED = 6;

/** Neighbouring songs pulled per seed track. */
const RECORDING_NEIGHBOURS = 60;

/**
 * Songs sampled from a seed album, spread evenly across the running order.
 *
 * An album seed used to have no song channel at all, so the only candidates it
 * could produce were its artist's neighbours — which is how two psychedelic
 * records returned a rap playlist. Its own tracklist is the fix, and it is a
 * far better signal than the artist's: asked about the thirteen recordings on
 * *Currents*, ListenBrainz knows all thirteen and returns Mac DeMarco, Unknown
 * Mortal Orchestra, MGMT, Pond, Melody's Echo Chamber and Mild High Club.
 *
 * Spread rather than taken from the front because the opening run of a record
 * is not the record. Five, because coverage is the thing that varies and it
 * varies by album rather than by track: *Currents* answers on the first song,
 * *Let's Start Here* on three of fourteen.
 */
const ALBUM_TRACK_SAMPLE = 5;

/**
 * Distinct artists from one album at which its remaining samples are skipped.
 * A well-known record reaches this on its first song, so the sample size above
 * is a ceiling paid only by the albums that need it.
 */
const ALBUM_ARTISTS_ENOUGH = 40;

/**
 * Below this mean pairwise agreement the seeds are not describing one sound,
 * and the playlist has to say so rather than implying a match it cannot make.
 */
const LOW_AGREEMENT = 0.25;

/**
 * How much being found from several seeds counts for.
 *
 * This is what makes a fourth pick worth adding. Genre fit already checks a
 * candidate against the consensus, but co-listening carries information the
 * tags do not — an artist who shows up in the neighbours of three of your five
 * songs is a better answer than one who shows up beside a single song, even at
 * equal genre fit, because three independent audiences put them there. At 0.6
 * full corroboration is worth about a 60% lift, enough to reorder the shortlist
 * without letting a well-connected artist ride on popularity alone.
 */
const CORROBORATION = 0.6;

/**
 * Consensus tags searched for artists directly, and how many each returns.
 *
 * The third candidate channel, and the only one that does not go through
 * anybody's listening history. Both of the others answer "who else do these
 * listeners play?", which is a different question from "what else sounds like
 * this" and diverges completely on a record whose audience came for its author:
 * every song on *Let's Start Here* that ListenBrainz knows returns rap, because
 * the people who played a psychedelic record by a rapper were rap listeners.
 * Tags are the only evidence that survives that, so a seed the co-listening
 * data cannot represent is still represented here.
 *
 * Ordered by strength × specificity so the calls are spent on "neo-psychedelia"
 * rather than on "rock", and stopping at four keeps the channel to four
 * rate-limited requests.
 */
const TAG_CHANNEL_TAGS = 4;
const TAG_CHANNEL_ARTISTS = 60;

/**
 * What a tag-channel artist is worth on the co-listening axis, where it has no
 * score at all. Half, so it competes on genre — which is the axis it was
 * selected on — without being ranked last on an axis it never entered.
 */
const TAG_CHANNEL_SIMILARITY = 0.5;

/**
 * Below this share of the shortlist matching every seed, the playlist is mostly
 * one-sided matches and should say so.
 */
const THIN_FULL_MATCH = 0.25;

function layerTags(
  target: Record<string, number>,
  tags: Readonly<Record<string, number>> | undefined,
  weight: number,
): void {
  if (!tags) return;
  for (const [tag, strength] of Object.entries(tags)) {
    const scaled = strength * weight;
    if (scaled > (target[tag] ?? 0)) target[tag] = scaled;
  }
}

/**
 * An even spread of `count` items across a list, endpoints included.
 *
 * Sampling an album's tracks from the front profiles its opening run rather
 * than the record: a sequenced album puts its singles at 1, 5 and 9, and the
 * side-two material that says what the thing actually is at the end.
 */
function spreadSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return items.length > 0 ? [items[0]] : [];

  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return out;
}

async function toSeeds(
  input: SoundsLikeInput,
  ctx: JobContext,
): Promise<SoundsLikeSeed[]> {
  if (input.seedKind === "tracks") {
    return (input.tracks ?? []).map((track) => ({
      key: track.mbids[0] ?? `${track.title}::${track.artistNames[0] ?? ""}`,
      title: track.title,
      artistNames: track.artistNames,
      artistMbid: track.artistMbid,
      kind: "track" as const,
      recordingMbids: track.mbids.slice(0, RECORDING_IDS_PER_SEED),
      albumMbid: track.albumMbid,
    }));
  }

  const albums = input.albums ?? [];
  const seeds: SoundsLikeSeed[] = [];

  for (const [index, album] of albums.entries()) {
    ctx.progress(index, albums.length + 4, `Reading ${album.title}…`);

    // One browse, cached for months, and it carries every recording id on the
    // record — the whole reason an album seed can now be asked about itself.
    // A record with no readable pressing still works, on its tags alone.
    const tracks = await catalog
      .getAlbumTracks({ mbid: album.mbid, title: album.title })
      .then((result) => result.data)
      .catch(() => []);

    seeds.push({
      key: album.mbid,
      title: album.title,
      artistNames: album.artistNames,
      artistMbid: album.artistMbid,
      kind: "album",
      recordingMbids: spreadSample(
        tracks.map((track) => track.mbid).filter((mbid): mbid is string => Boolean(mbid)),
        ALBUM_TRACK_SAMPLE,
      ),
      albumMbid: album.mbid,
    });
  }

  return seeds;
}

/**
 * Genre profiles for every seed, in three batched requests rather than three
 * per seed.
 */
async function profileSeeds(seeds: readonly SoundsLikeSeed[]): Promise<SeedProfile[]> {
  const recordingIds = seeds.flatMap((seed) => seed.recordingMbids);
  const albumIds = seeds
    .map((seed) => seed.albumMbid)
    .filter((id): id is string => Boolean(id));
  const artistIds = seeds
    .map((seed) => seed.artistMbid)
    .filter((id): id is string => Boolean(id));

  const empty = new Map<string, Record<string, number>>();
  const lookup = async (
    ids: readonly string[],
    fetcher?: (ids: readonly string[]) => Promise<{ data: Map<string, Record<string, number>> }>,
  ) => {
    if (ids.length === 0 || !fetcher) return empty;
    // A missing layer costs precision, not correctness — the other two still
    // describe the seed — so a failure here degrades rather than aborts.
    return fetcher(ids).then((result) => result.data).catch(() => empty);
  };

  const [recordingTags, albumTags, artistTags] = await Promise.all([
    lookup(recordingIds, catalog.getRecordingProfiles?.bind(catalog)),
    lookup(albumIds, catalog.getReleaseGroupProfiles?.bind(catalog)),
    lookup(artistIds, catalog.getTagProfiles?.bind(catalog)),
  ]);

  return seeds.map((seed) => {
    const tags: Record<string, number> = {};
    // An album's sampled tracks describe the same record its own tags do, so
    // they join at the album's weight rather than outranking it; a song seed's
    // ids are all that song, and lead.
    const ownWeight =
      seed.kind === "track" ? RECORDING_TAG_WEIGHT : ALBUM_TAG_WEIGHT;
    for (const mbid of seed.recordingMbids) {
      layerTags(tags, recordingTags.get(mbid), ownWeight);
    }
    if (seed.albumMbid) layerTags(tags, albumTags.get(seed.albumMbid), ALBUM_TAG_WEIGHT);

    // The artist only speaks for a record that has not spoken for itself. See
    // OWN_TAGS_ENOUGH: on a record that departs from its author's catalogue,
    // this layer describes the catalogue and buries the departure.
    const own = Object.keys(tags).filter((tag) => tagSpecificity(tag) > 0).length;
    if (seed.artistMbid && own < OWN_TAGS_ENOUGH) {
      layerTags(tags, artistTags.get(seed.artistMbid), ARTIST_TAG_WEIGHT);
    }

    return { key: seed.key, tags };
  });
}

/**
 * Artists worth considering, gathered from every seed and ranked against what
 * the seeds agree on.
 *
 * Two channels, because they answer different questions. Song neighbours come
 * from people who played THAT TRACK in the same session, which is the only
 * signal that can tell one track on a record from another; artist neighbours
 * are broader but exist for every seed and reach much further. Both feed the
 * same pool, where being found twice is itself evidence.
 */
async function gatherSoundsLikeCandidates(
  seeds: readonly SoundsLikeSeed[],
  consensus: ConsensusProfile,
  limit: number,
  band: ObscurityBand,
  ctx: JobContext,
): Promise<{ artists: ScoredArtistRef[]; warnings: string[] }> {
  const consensusTags = consensus.tags;
  const identity = (ref: { name: string }) =>
    normalizeArtistName(ref.name) || ref.name.trim().toLowerCase();

  const excluded = new Set(
    seeds.flatMap((seed) => seed.artistNames.map((name) => identity({ name }))),
  );
  const excludedMbids = new Set(
    seeds.map((seed) => seed.artistMbid).filter((id): id is string => Boolean(id)),
  );

  const merged = new Map<string, ScoredArtistRef>();
  /** Which seeds turned each candidate up — the corroboration count. */
  const support = new Map<string, Set<string>>();

  const absorb = (
    seedKey: string,
    neighbour: { mbid?: string; name: string; score: number; tags?: Record<string, number> },
  ) => {
    const key = identity(neighbour);
    if (!key || excluded.has(key)) return;
    if (neighbour.mbid && excludedMbids.has(neighbour.mbid)) return;

    const existing = merged.get(key);
    merged.set(key, {
      ...(existing ?? {}),
      mbid: existing?.mbid ?? neighbour.mbid,
      name: existing?.name ?? neighbour.name,
      tags: existing?.tags ?? neighbour.tags,
      score: Math.max(existing?.score ?? 0, neighbour.score),
    });

    if (!seedKey) return;
    const seen = support.get(key);
    if (seen) seen.add(seedKey);
    else support.set(key, new Set([seedKey]));
  };

  /**
   * For candidates that came from no seed's audience at all. They enter the
   * pool on their tags and are judged on their tags — crediting them with
   * co-listening support they do not have would let the tag channel manufacture
   * the corroboration that the other two channels have to earn.
   */
  const absorbUnsupported = (neighbour: {
    mbid?: string;
    name: string;
    score: number;
    tags?: Record<string, number>;
  }) => absorb("", neighbour);

  const provider = similarityProviders[0];
  const askFor = Math.max(100, limit * 3);
  const steps = seeds.length + 3;

  for (const [index, seed] of seeds.entries()) {
    ctx.progress(index, steps, `Finding music like ${seed.title}…`);

    if (seed.recordingMbids.length > 0 && provider.getSimilarRecordings) {
      // A song's ids are versions of one thing, so the first that answers is
      // the answer. An album's are different songs, so each is asked in turn
      // and the neighbourhoods pooled — stopping early once the record has
      // named enough people, which for anything well known is one song.
      const groups =
        seed.kind === "track"
          ? [seed.recordingMbids]
          : seed.recordingMbids.map((mbid) => [mbid]);

      const found = new Set<string>();
      for (const group of groups) {
        if (seed.kind === "album" && found.size >= ALBUM_ARTISTS_ENOUGH) break;
        try {
          const neighbours = await provider.getSimilarRecordings(
            group,
            RECORDING_NEIGHBOURS,
          );
          for (const row of neighbours.data) {
            const name = row.artistNames[0];
            if (!name) continue;
            found.add(identity({ name }));
            absorb(seed.key, { mbid: row.artistMbids[0], name, score: row.score });
          }
        } catch {
          // No SLA on the labs endpoints; the other channels still cover this seed.
        }
      }
    }

    if (seed.artistMbid) {
      try {
        const neighbours = await provider.getSimilarArtists(
          { mbid: seed.artistMbid, name: seed.artistNames[0] ?? seed.title },
          askFor,
        );
        for (const neighbour of neighbours.data) absorb(seed.key, neighbour);
      } catch {
        // Same.
      }
    }
  }

  ctx.progress(seeds.length, steps, "Looking for the same sound elsewhere…");
  await gatherByTag(consensusTags, absorbUnsupported);

  if (merged.size === 0) return { artists: [], warnings: [] };

  ctx.progress(seeds.length + 1, steps, "Checking genres…");
  await attachTagProfiles(merged);

  const seedCount = seeds.length;
  const scored = [...merged.entries()].map(([key, candidate]) => {
    const supported = support.get(key) ?? new Set<string>();
    const found = Math.max(1, supported.size);
    return {
      candidate,
      fit: candidate.tags ? tagCosine(consensusTags, candidate.tags) : undefined,
      /**
       * How many of the listener's picks this candidate answers to — the tier
       * it is filled from. See matchedSeedCount: an artist both your records
       * point at outranks one only a single record points at, however strong
       * that one claim is, and the shortlist only reaches down a tier when the
       * one above it cannot fill the playlist.
       */
      matched: matchedSeedCount(candidate.tags, consensus.seeds, supported),
      /** Whether any seed's own audience turned this candidate up. */
      supported: supported.size > 0,
      // Ranked, not scaled — see rankByGenreThenSimilarity — so what matters
      // here is only that corroboration moves a candidate up the order.
      similarity:
        candidate.score *
        (1 + CORROBORATION * ((found - 1) / Math.max(1, seedCount - 1))),
    };
  });

  const measured = scored
    .map((entry) => entry.fit)
    .filter((fit): fit is number => fit !== undefined);
  const meanFit =
    measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 0.5;

  const withFit = scored.map((entry) => ({ ...entry, fit: entry.fit ?? meanFit }));

  // Same reasoning as the single-artist path: about half of any co-listening
  // list has no measurable genre relationship to the seed at all, and those are
  // dropped unless doing so would leave too little to build from.
  const onGenre = withFit.filter((entry) => entry.fit > 0);
  const usable = onGenre.length >= limit ? onGenre : withFit;

  const ordering = rankByGenreThenSimilarity(
    usable.map((entry) => ({ similarity: entry.similarity, fit: entry.fit })),
    band,
  );

  /**
   * Tier first, quality second.
   *
   * The score from rankByGenreThenSimilarity settles the order inside a tier
   * and is deliberately not allowed to cross one, because the two answer
   * different questions. That score says how good a candidate is against the
   * average of the picks; the tier says how many of the picks it actually
   * answers to. A rap artist with a commanding co-listening score sits below an
   * obscure psychedelic one here not because it scored worse but because it was
   * only ever an answer to one of the two records — and it stays reachable,
   * because a thin top tier simply runs out and the next one fills the rest.
   */
  const pool = usable
    .map((entry, index) => ({
      ...entry.candidate,
      matched: entry.matched,
      supported: entry.supported,
      score: ordering[index],
    }))
    /**
     * Within a tier, whoever turned up in one of the seeds' audiences comes
     * first, because the tag channel did not discover anything — it re-searched
     * the description the seeds produced. An artist matching only the tags
     * matches how the record was labelled; an artist who also appears beside it
     * in real listening matches the record.
     *
     * It shows. Left purely on genre, two 2015-and-2023 psychedelic albums
     * returned The Electric Prunes and Tommy James & The Shondells: correct
     * against a profile whose strongest tag is "psychedelic rock", and half a
     * century from what was asked for. The co-listening data had already named
     * Mac DeMarco, Unknown Mortal Orchestra, MGMT and Pond, and this is what
     * puts them back in front of it — while leaving the tag channel exactly
     * where it earns its place, filling in behind a seed whose own audience had
     * nothing on-genre to offer.
     */
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        Number(b.supported) - Number(a.supported) ||
        b.score - a.score,
    );

  for (const candidate of pool) {
    if (candidate.mbid && candidate.tags) {
      rememberArtist({ mbid: candidate.mbid, name: candidate.name, tags: candidate.tags });
    }
  }

  /**
   * The obscurity band is applied INSIDE each group, never across them.
   *
   * selectByDepth works by skipping the head of a ranked list, because the head
   * of a co-listening list is whoever is most listened to overall — skipping it
   * is what turns similarity into discovery. Run over the whole shortlist it
   * would now skip the candidates that match every pick, which is the exact
   * opposite of what it is for.
   *
   * Grouping by tier alone is not enough either, and the measurement is
   * unambiguous. The tag channel can supply two hundred artists that match
   * every seed's genre while the seeds' own audiences supply ten; a 15% skip
   * over a group of two hundred is a skip of thirty, and those ten are gone.
   * Each (tier, has-support) group is therefore sliced on its own, so the depth
   * skip only ever passes over the obvious members of a group and cannot
   * silently delete a whole kind of evidence.
   */
  const groups = [...new Set(pool.map((entry) => `${entry.matched}:${entry.supported}`))];
  const artists: typeof pool = [];
  for (const group of groups) {
    if (artists.length >= limit) break;
    artists.push(
      ...selectByDepth(
        pool.filter((entry) => `${entry.matched}:${entry.supported}` === group),
        band,
        limit - artists.length,
      ),
    );
  }

  const warnings: string[] = [];
  if (seedCount >= 2 && artists.length > 0) {
    const full = artists.filter((artist) => artist.matched >= seedCount).length;
    if (full < artists.length * THIN_FULL_MATCH) {
      warnings.push(
        `Few artists match all ${seedCount} of your picks, so most of this playlist matches one of them closely rather than all of them a little.`,
      );
    }
  }

  return { artists, warnings };
}

/**
 * Artists MusicBrainz files under the sound itself, rather than under anyone
 * who listens to it.
 *
 * See TAG_CHANNEL_TAGS. Tags are ordered by strength × specificity so the four
 * calls buy "neo-psychedelia" and not "rock", and anything at or below the
 * umbrella tier is skipped outright — a page of artists tagged "rock" is not a
 * candidate pool, it is a phone book.
 */
async function gatherByTag(
  consensusTags: Readonly<Record<string, number>>,
  absorb: (artist: ScoredArtistRef) => void,
): Promise<void> {
  const chosen = Object.entries(consensusTags)
    .map(([tag, strength]) => ({ tag, weight: strength * tagSpecificity(tag) }))
    .filter((entry) => tagSpecificity(entry.tag) >= 0.5)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TAG_CHANNEL_TAGS);

  for (const { tag, weight } of chosen) {
    try {
      const found = await tags.getArtistsForTag(tag, TAG_CHANNEL_ARTISTS);
      for (const artist of found.data) {
        absorb({
          ...artist,
          // Scaled by how central the tag is to the consensus, so an artist
          // found under the profile's strongest tag outranks one found under
          // its fourth.
          score: artist.score * weight * TAG_CHANNEL_SIMILARITY,
        });
      }
    } catch {
      // The tag index is a bonus channel; the co-listening ones still stand.
    }
  }
}

/**
 * A playlist built from what several songs or albums have in common.
 *
 * The difference from the single-artist discovery mode is what the playlist is
 * anchored to. There, the anchor is one artist's genre profile. Here it is the
 * consensus across everything the listener picked — which is both narrower and
 * better evidence, because a tag only survives it if more than one of their
 * picks carries it.
 */
export async function runSoundsLike(
  input: SoundsLikeInput,
  ctx: JobContext,
): Promise<GenerationResult> {
  const { constraints } = input;
  const warnings: string[] = [];
  const noun = input.seedKind === "tracks" ? "song" : "album";

  ctx.progress(0, 5, `Reading your ${noun}${(input.albums ?? input.tracks ?? []).length === 1 ? "" : "s"}…`);

  const seeds = await toSeeds(input, ctx);

  if (seeds.length === 0) {
    return { warnings: [`No ${noun}s were chosen.`], trackCount: 0 };
  }

  const consensus = consensusProfile(await profileSeeds(seeds));

  if (consensus.usedSeeds === 0) {
    return {
      warnings: [
        seeds.length === 1
          ? `MusicBrainz has no genre information for that ${noun}, so there is nothing to match against. Adding a second ${noun} usually fixes it.`
          : `MusicBrainz has no genre information for any of those ${noun}s, so there is nothing to match against. Try a better-known ${noun} alongside them.`,
      ],
      trackCount: 0,
    };
  }

  if (consensus.usedSeeds < seeds.length) {
    const missing = seeds.length - consensus.usedSeeds;
    warnings.push(
      `${missing} of your ${seeds.length} ${noun}s had no genre data, so the playlist was built from the other ${consensus.usedSeeds}.`,
    );
  }

  if (consensus.usedSeeds >= 2 && consensus.agreement < LOW_AGREEMENT) {
    warnings.push(
      `Those ${noun}s have little in common musically, so this playlist covers all of them rather than matching one sound. Picks that sit closer together give a sharper result.`,
    );
  }

  const wanted = Math.min(
    MAX_SHORTLIST,
    Math.ceil(
      artistsNeededFor(constraints.targetLength, constraints.maxPerArtist) *
        DISCOVERY_OVERSHOOT,
    ),
  );

  const { artists: similar, warnings: shortlistWarnings } =
    await gatherSoundsLikeCandidates(
      seeds,
      consensus,
      wanted,
      constraints.obscurity,
      ctx,
    );
  warnings.push(...shortlistWarnings);

  if (similar.length === 0) {
    return {
      warnings: [
        ...warnings,
        `Nothing similar could be found for those ${noun}s. They may be too new or too obscure to have listening data yet.`,
      ],
      trackCount: 0,
    };
  }

  const contributors = await loadContributors(similar, constraints, ctx, {
    label: (name) => `Listening to ${name}…`,
    withPopularity: true,
    capacityTarget: Math.ceil(constraints.targetLength * DISCOVERY_OVERSHOOT),
  });

  const label =
    seeds.length === 1 ? `"${seeds[0].title}"` : `these ${seeds.length} ${noun}s`;

  const result = buildDiscovery({
    seedArtistName: label,
    seedTags: consensus.tags,
    similar: contributors,
    constraints,
    reason:
      seeds.length === 1
        ? `sounds like ${label}`
        : `sounds like your ${seeds.length} ${noun}s`,
    // Everyone who made a seed is left out, on their own tracks and on other
    // people's. Someone who names five songs is asking what else there is.
    excludeCreditNames: seeds.flatMap((seed) => seed.artistNames),
    excludeArtistKeys: new Set([
      ...seeds.map((seed) => seed.artistMbid).filter((id): id is string => Boolean(id)),
      ...seeds.flatMap((seed) => seed.artistNames),
    ]),
  });

  return persist(input.playlistId, result, warnings);
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

  // Sized from the request: a 200-track playlist at two per artist needs a
  // hundred artists that survive resolution and filtering, where the fixed 60
  // this used to fetch could not even supply half of that.
  const needed = artistsNeededFor(
    input.constraints.targetLength,
    input.constraints.maxPerArtist,
  );
  const perTag = Math.min(
    400,
    Math.max(60, Math.ceil((needed * 2.5) / seeds.length)),
  );

  const artistsByKey = new Map<string, EngineArtist>();

  for (const [index, seed] of seeds.entries()) {
    ctx.progress(index, seeds.length + 6, `Finding ${seed.tag} artists…`);

    const found = await tags.getArtistsForTag(seed.tag, perTag);
    for (const artist of found.data) {
      addArtist(artistsByKey, artist, seed.tag, seed.weight);
    }

    // A thin tag gets widened with its nearest neighbours, discounted so the
    // original request still dominates the result.
    if (found.data.length < Math.max(THIN_TAG_THRESHOLD, perTag * 0.5)) {
      try {
        const related = await tags.getSimilarTags(seed.tag, 4);
        for (const neighbour of related.data.slice(0, 3)) {
          const extra = await tags.getArtistsForTag(
            neighbour.tag,
            Math.ceil(perTag * 0.7),
          );
          for (const artist of extra.data) {
            addArtist(artistsByKey, artist, seed.tag, seed.weight * 0.5);
          }
        }
        if (related.data.length > 0) {
          warnings.push(
            `Not enough artists are tagged "${seed.tag}" to fill a playlist this long, so closely related styles were included too.`,
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
  const shortlist = candidates
    .sort((a, b) => scoreOf(b, seeds) - scoreOf(a, seeds))
    .slice(0, Math.min(candidates.length, MAX_SHORTLIST, Math.ceil(needed * 2.2)));

  // Loading stops as soon as the pool could fill the playlist with room to
  // spare, so a well-resolving shortlist costs a fraction of its full length.
  const capacityTarget = Math.ceil(input.constraints.targetLength * POOL_HEADROOM);
  const loaded: EngineArtist[] = [];
  let capacity = 0;

  for (const [index, artist] of shortlist.entries()) {
    ctx.progress(
      seeds.length + index,
      seeds.length + shortlist.length + 1,
      `Loading ${artist.name}… (${index + 1}/${shortlist.length})`,
    );

    const ref: ArtistRef = { mbid: artist.mbid, name: artist.name };
    const pool = await loadTopTracks(ref, artist.key, 25);
    artist.tracks = pool.tracks;

    if (pool.tracks.length > 0) {
      loaded.push(artist);
      const usable = pool.tracks.filter((track) =>
        passesFilters(track, input.constraints),
      );
      capacity += Math.min(input.constraints.maxPerArtist, usable.length);
    }

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

    if (capacity >= capacityTarget) break;
  }

  ctx.progress(
    seeds.length + shortlist.length,
    seeds.length + shortlist.length + 1,
    "Building the playlist…",
  );

  const result = generateStylePlaylist({
    seeds,
    artists: loaded,
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
    // A second tag's search may carry a profile the first one lacked.
    if (!existing.tags && artist.tags) existing.tags = artist.tags;
    return;
  }

  target.set(key, {
    key,
    mbid: artist.mbid,
    name: artist.name,
    tagAffinity: { [tag]: affinity },
    // Rides along in the tag search response — see mapArtist.
    tags: artist.tags,
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
