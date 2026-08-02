import { capPerArtist, relaxToFill } from "./diversity";
import {
  distributeSeed,
  interleave,
  roundRobinByKey,
  separateAdjacent,
  type Queue,
} from "./interleave";
import { selectTracksForBand } from "./obscurity";
import { dedupeTracks, passesFilters } from "./titleFilters";
import type {
  EngineArtist,
  EngineTrack,
  GeneratedPlaylist,
  StyleConstraints,
} from "./types";

/**
 * "Introduce me to an artist" — three ways in.
 *
 * Pure, like stylePlaylist.ts. Popularity is expected to be pre-normalised
 * 0-100 within its source; tracks with unknown popularity are usable but can
 * never be presented as either a hit or a deep cut.
 */

export interface FamousInput {
  artist: EngineArtist;
  constraints: StyleConstraints;
  /**
   * Album tracks used only to top up a request longer than the popularity
   * provider can answer — its chart endpoint stops at 100 tracks however many
   * are asked for.
   *
   * These are appended, never merged: their popularity is normalised within
   * their own album, so a quiet record's best track scores 100 exactly like a
   * genuine hit does. Interleaving the two scales would put album openers above
   * the singles and quietly turn "the essentials" into a lie.
   */
  supplement?: readonly EngineTrack[];
}

export function buildFamous(input: FamousInput): GeneratedPlaylist {
  const { artist, constraints, supplement = [] } = input;
  const warnings: string[] = [];

  const usable = dedupeTracks(
    artist.tracks.filter((track) => passesFilters(track, constraints)),
  );

  const ranked = usable.filter((track) => track.popularity !== undefined);
  if (ranked.length === 0) {
    // No popularity data at all: order is arbitrary, so say so rather than
    // implying these are the hits.
    warnings.push(
      `No popularity data was available for ${artist.name}, so these are a sample of their catalogue rather than their best-known tracks.`,
    );
    return {
      tracks: usable.slice(0, constraints.targetLength).map((track) => ({
        ...track,
        reason: "from their catalogue",
      })),
      warnings,
    };
  }

  let tracks: EngineTrack[] = ranked
    .slice()
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, constraints.targetLength)
    .map((track) => ({ ...track, reason: "one of their best-known tracks" }));

  if (tracks.length < constraints.targetLength && supplement.length > 0) {
    const extras = supplement
      .filter((track) => passesFilters(track, constraints))
      .slice()
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .map((track) => ({
        ...track,
        reason: track.album ? `standout from ${track.album}` : "from their catalogue",
      }));

    // dedupeTracks keeps the first occurrence, so the charting versions above
    // survive and their album duplicates drop out.
    const merged = dedupeTracks([...tracks, ...extras]).slice(
      0,
      constraints.targetLength,
    );

    if (merged.length > tracks.length) {
      warnings.push(
        `Only ${tracks.length} of ${artist.name}'s tracks have chart popularity data, so the rest are the standout tracks from their albums.`,
      );
      tracks = merged;
    }
  }

  if (tracks.length < constraints.targetLength) {
    warnings.push(
      `Found ${tracks.length} of ${constraints.targetLength} tracks — ${artist.name}'s catalogue may be smaller than that.`,
    );
  }

  return { tracks, warnings };
}

export interface DeepCutsInput {
  artist: EngineArtist;
  constraints: StyleConstraints;
  /** Keys of the artist's best-known tracks, which deep cuts must avoid. */
  excludeKeys?: Set<string>;
  /** Cap per album so one record doesn't dominate. */
  maxPerAlbum?: number;
}

/**
 * Deep cuts are chosen per album and ordered chronologically: played in
 * release order they tell the story of a career, which is exactly what someone
 * digging past the singles is after.
 */
export function buildDeepCuts(input: DeepCutsInput): GeneratedPlaylist {
  const { artist, constraints, excludeKeys = new Set(), maxPerAlbum = 2 } = input;
  const warnings: string[] = [];

  const usable = artist.tracks.filter(
    (track) =>
      passesFilters(track, constraints) &&
      !excludeKeys.has(track.key) &&
      !excludeKeys.has(track.titleNorm),
  );

  if (usable.length === 0) {
    return {
      tracks: [],
      warnings: [`No album tracks were found for ${artist.name} beyond their singles.`],
    };
  }

  const byAlbum = new Map<string, EngineTrack[]>();
  for (const track of usable) {
    const key = track.albumKey ?? track.album ?? "unknown";
    const bucket = byAlbum.get(key);
    if (bucket) bucket.push(track);
    else byAlbum.set(key, [track]);
  }

  const picked: EngineTrack[] = [];
  for (const [, albumTracks] of byAlbum) {
    // Rank within the album, not the whole catalogue: a quiet album's best
    // track is still a deep cut, and a huge album's filler still is too.
    const deep = selectTracksForBand(albumTracks, "hard", maxPerAlbum);
    const chosen = deep.length > 0 ? deep : albumTracks.slice(0, maxPerAlbum);
    for (const track of chosen) {
      picked.push({
        ...track,
        reason: track.album
          ? `deep cut from ${track.album}${track.year ? ` (${track.year})` : ""}`
          : "deep cut",
      });
    }
  }

  const tracks = dedupeTracks(picked)
    .sort((a, b) => {
      const yearA = a.year ?? Number.MAX_SAFE_INTEGER;
      const yearB = b.year ?? Number.MAX_SAFE_INTEGER;
      if (yearA !== yearB) return yearA - yearB;
      return (a.album ?? "").localeCompare(b.album ?? "");
    })
    .slice(0, constraints.targetLength);

  if (tracks.length < constraints.targetLength) {
    warnings.push(
      `Found ${tracks.length} deep cuts for ${artist.name} — their catalogue may be small or only partly covered.`,
    );
  }

  return { tracks, warnings };
}

export interface BlendInput {
  seedArtist: EngineArtist;
  /** Similar artists, each carrying a 0-1 similarity in `score`. */
  similar: { artist: EngineArtist; score: number }[];
  constraints: StyleConstraints;
  /** Share of the playlist reserved for the seed artist. */
  seedShare?: number;
}

/**
 * A blend keeps returning to the artist being introduced while surrounding
 * them with neighbours, so the listener hears them in context rather than in
 * isolation.
 */
export function buildBlend(input: BlendInput): GeneratedPlaylist {
  const { seedArtist, similar, constraints, seedShare = 0.35 } = input;
  const warnings: string[] = [];

  const seedSlots = Math.max(1, Math.round(constraints.targetLength * seedShare));

  const seedTracks = selectTracksForBand(
    dedupeTracks(seedArtist.tracks.filter((t) => passesFilters(t, constraints))),
    constraints.obscurity,
    seedSlots,
  ).map((track) => ({ ...track, reason: `by ${seedArtist.name}` }));

  // Sized from what the seed actually supplied, not from what it was offered.
  // An artist with a thin catalogue cannot fill 35% of a 200-track playlist,
  // and the honest response is to hand those slots to the neighbours — a blend
  // of 50 seed tracks and 150 others is still a blend, and still the length
  // that was asked for, where padding the seed or stopping short is neither.
  const otherSlots = Math.max(0, constraints.targetLength - seedTracks.length);

  const contributors = similar
    .filter((entry) => entry.score > 0 && entry.artist.tracks.length > 0)
    .sort((a, b) => b.score - a.score);

  if (contributors.length === 0) {
    warnings.push(
      `No similar artists were found for ${seedArtist.name}, so this playlist covers them alone.`,
    );
    return {
      tracks: seedTracks.slice(0, constraints.targetLength),
      warnings,
    };
  }

  // Slots are proportional to similarity, but every contributor gets at least
  // one: a blend of two artists plus a long tail of single tracks is more
  // interesting than three artists split evenly.
  //
  // Each contributor becomes its own queue so the merge alternates between
  // them. Concatenating instead would clump every artist's picks together, and
  // no amount of adjacent-swapping afterwards can fully unpick that.
  const totalScore = contributors.reduce((sum, entry) => sum + entry.score, 0);
  const queues: Queue<EngineTrack>[] = [];
  const reserves: EngineTrack[] = [];

  for (const entry of contributors) {
    const share = totalScore > 0 ? entry.score / totalScore : 1 / contributors.length;
    const slots = Math.min(
      constraints.maxPerArtist,
      Math.max(1, Math.round(share * otherSlots)),
    );

    const usable = dedupeTracks(
      entry.artist.tracks.filter((track) => passesFilters(track, constraints)),
    );
    const picked = selectTracksForBand(usable, constraints.obscurity, slots);
    if (picked.length === 0) continue;

    const explain = (track: EngineTrack) => ({
      ...track,
      reason: `similar to ${seedArtist.name}`,
    });

    queues.push({
      key: entry.artist.key,
      weight: entry.score,
      items: picked.map(explain),
    });

    // Held back for the shortfall pass below.
    reserves.push(...usable.filter((track) => !picked.includes(track)).map(explain));
  }

  let capped = capPerArtist(
    dedupeTracks(interleave(queues, { maxRun: 1 })),
    constraints.maxPerArtist,
  ).slice(0, otherSlots);

  // Slots are handed out proportionally, so a long blend spread across many
  // neighbours gives almost all of them one track and lands short of the
  // request even though the cap allowed a second from each. Fill from the
  // reserves before giving up on the length the listener asked for.
  if (capped.length < otherSlots) {
    const filled = relaxToFill(
      capped,
      dedupeTracks(reserves),
      otherSlots,
      constraints.maxPerArtist,
      // Never above the cap here. The cap is the blend's promise: break it and
      // "and friends" collapses back into the single-artist playlist the
      // listener was trying to get away from. A short blend is the better miss.
      0,
    );
    // Rotating rather than appending: the top-ups all arrived grouped by
    // artist, and the later repair pass cannot unpick a long run of that.
    capped = roundRobinByKey(
      filled.tracks.slice(0, otherSlots),
      (track) => track.artistKey,
    );
  }

  // Space the seed artist through the result rather than front-loading them.
  const every = capped.length > 0 ? Math.max(2, Math.round(capped.length / Math.max(1, seedTracks.length))) : 2;
  let tracks = distributeSeed(seedTracks, capped, Math.min(4, every));
  tracks = separateAdjacent(tracks, (track) => track.artistKey).slice(
    0,
    constraints.targetLength,
  );

  if (tracks.length < constraints.targetLength) {
    warnings.push(
      `Found ${tracks.length} of ${constraints.targetLength} tracks for this blend.`,
    );
  }

  return { tracks, warnings };
}
