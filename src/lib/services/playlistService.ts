import {
  replacePlaylistTracks,
  type PlaylistTrackInput,
} from "@/lib/db/repo/playlists";
import { upsertArtist } from "@/lib/db/repo/artists";
import { saveSimilarArtists } from "@/lib/db/repo/similarity";
import { saveArtistTags } from "@/lib/db/repo/tags";
import { savePopularity } from "@/lib/db/repo/recordings";
import { consensusProfile, type SeedProfile } from "@/lib/engine/consensus";
import { selectByDepth } from "@/lib/engine/obscurity";
import { rankByGenreThenSimilarity, tagCosine } from "@/lib/engine/scoring";
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
  /** Empty for an album seed. */
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

/** Alternate recording ids profiled per seed song. */
const RECORDING_IDS_PER_SEED = 6;

/** Neighbouring songs pulled per seed track. */
const RECORDING_NEIGHBOURS = 60;

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

function toSeeds(input: SoundsLikeInput): SoundsLikeSeed[] {
  if (input.seedKind === "tracks") {
    return (input.tracks ?? []).map((track) => ({
      key: track.mbids[0] ?? `${track.title}::${track.artistNames[0] ?? ""}`,
      title: track.title,
      artistNames: track.artistNames,
      artistMbid: track.artistMbid,
      recordingMbids: track.mbids.slice(0, RECORDING_IDS_PER_SEED),
      albumMbid: track.albumMbid,
    }));
  }

  return (input.albums ?? []).map((album) => ({
    key: album.mbid,
    title: album.title,
    artistNames: album.artistNames,
    artistMbid: album.artistMbid,
    recordingMbids: [],
    albumMbid: album.mbid,
  }));
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
    for (const mbid of seed.recordingMbids) {
      layerTags(tags, recordingTags.get(mbid), RECORDING_TAG_WEIGHT);
    }
    if (seed.albumMbid) layerTags(tags, albumTags.get(seed.albumMbid), ALBUM_TAG_WEIGHT);
    if (seed.artistMbid) layerTags(tags, artistTags.get(seed.artistMbid), ARTIST_TAG_WEIGHT);
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
  consensusTags: Readonly<Record<string, number>>,
  limit: number,
  band: ObscurityBand,
  ctx: JobContext,
): Promise<ScoredArtistRef[]> {
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

    const seen = support.get(key);
    if (seen) seen.add(seedKey);
    else support.set(key, new Set([seedKey]));
  };

  const provider = similarityProviders[0];
  const askFor = Math.max(100, limit * 3);

  for (const [index, seed] of seeds.entries()) {
    ctx.progress(index, seeds.length + 2, `Finding music like ${seed.title}…`);

    if (seed.recordingMbids.length > 0 && provider.getSimilarRecordings) {
      try {
        const neighbours = await provider.getSimilarRecordings(
          seed.recordingMbids,
          RECORDING_NEIGHBOURS,
        );
        for (const row of neighbours.data) {
          const name = row.artistNames[0];
          if (!name) continue;
          absorb(seed.key, { mbid: row.artistMbids[0], name, score: row.score });
        }
      } catch {
        // No SLA on the labs endpoints; the artist channel still covers this seed.
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

  if (merged.size === 0) return [];

  ctx.progress(seeds.length, seeds.length + 2, "Checking genres…");
  await attachTagProfiles(merged);

  const seedCount = seeds.length;
  const scored = [...merged.entries()].map(([key, candidate]) => {
    const found = support.get(key)?.size ?? 1;
    return {
      candidate,
      fit: candidate.tags ? tagCosine(consensusTags, candidate.tags) : undefined,
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
  const seeds = toSeeds(input);
  const noun = input.seedKind === "tracks" ? "song" : "album";

  if (seeds.length === 0) {
    return { warnings: [`No ${noun}s were chosen.`], trackCount: 0 };
  }

  ctx.progress(0, 5, `Reading your ${noun}${seeds.length === 1 ? "" : "s"}…`);

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

  const similar = await gatherSoundsLikeCandidates(
    seeds,
    consensus.tags,
    wanted,
    constraints.obscurity,
    ctx,
  );

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
