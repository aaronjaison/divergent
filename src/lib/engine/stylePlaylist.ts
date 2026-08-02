import { capPerArtist, relaxToFill } from "./diversity";
import {
  interleave,
  roundRobinByKey,
  separateAdjacent,
  type Queue,
} from "./interleave";
import { bandAffinity, percentileRanks, selectTracksForBand } from "./obscurity";
import { createRng, weightedSampleWithoutReplacement } from "./random";
import { selectCoherent } from "./scoring";
import { dedupeTracks, passesFilters } from "./titleFilters";
import type {
  EngineArtist,
  EngineTrack,
  GeneratedPlaylist,
  StyleConstraints,
  WeightedTag,
} from "./types";

/**
 * Style-based playlist generation.
 *
 * Pure: the caller assembles the artist pool from whatever providers are
 * available and hands it over. The engine never learns which source anything
 * came from, which is what lets non-commercial providers be swapped out later
 * without touching this file.
 */

/**
 * How much fitting the rest of the playlist outweighs raw tag affinity. Lower
 * than discovery's, because here the listener named the style themselves and
 * the request has to stay recognisable as the thing they asked for.
 */
const COHESION = 0.5;

export interface StylePlaylistInput {
  seeds: WeightedTag[];
  artists: EngineArtist[];
  constraints: StyleConstraints;
}

/** Sum of an artist's affinity for the requested tags, weighted by seed weight. */
export function tagScore(artist: EngineArtist, seeds: readonly WeightedTag[]): number {
  let score = 0;
  for (const seed of seeds) {
    const affinity = artist.tagAffinity[seed.tag];
    if (affinity) score += affinity * seed.weight;
  }
  return score;
}

/** The seed an artist best represents, used to build the interleave queues. */
function dominantSeed(
  artist: EngineArtist,
  seeds: readonly WeightedTag[],
): string {
  let best = seeds[0]?.tag ?? "";
  let bestValue = -1;
  for (const seed of seeds) {
    const value = (artist.tagAffinity[seed.tag] ?? 0) * seed.weight;
    if (value > bestValue) {
      bestValue = value;
      best = seed.tag;
    }
  }
  return best;
}

export function generateStylePlaylist(
  input: StylePlaylistInput,
): GeneratedPlaylist {
  const { seeds, artists, constraints } = input;
  const warnings: string[] = [];
  const rng = createRng(constraints.seed);

  const eligible = artists.filter((artist) => artist.tracks.length > 0);
  if (eligible.length === 0) {
    return { tracks: [], warnings: ["No artists with playable tracks were found."] };
  }

  // Percentiles are computed within this pool only — see obscurity.ts.
  // Artists with unknown popularity sit at the median rather than the bottom,
  // so a provider gap doesn't masquerade as obscurity.
  const known = eligible.filter((a) => a.popularity !== undefined);
  const ranks = percentileRanks(known.map((a) => a.popularity as number));
  const percentileByKey = new Map<string, number>();
  known.forEach((artist, index) => percentileByKey.set(artist.key, ranks[index]));
  for (const artist of eligible) {
    if (!percentileByKey.has(artist.key)) percentileByKey.set(artist.key, 50);
  }

  const weightOf = (artist: EngineArtist): number => {
    const tags = tagScore(artist, seeds);
    if (tags <= 0) return 0;
    const percentile = percentileByKey.get(artist.key) ?? 50;
    return tags * bandAffinity(percentile, constraints.obscurity);
  };

  /**
   * A requested tag can be far broader than a playlist: "rap" is answered
   * equally well by a drill record and a lo-fi bedroom track, and a pool
   * scored only on "does this artist match the tag" samples across that whole
   * spread. The result is technically on-topic and incoherent to listen to.
   *
   * So candidates are first narrowed to a group that fits each other, using
   * the requested tags as the anchor. Broad requests settle into one corner;
   * an already-narrow request has only one corner to find and is unaffected.
   */
  const anchor: Record<string, number> = {};
  for (const seed of seeds) anchor[seed.tag] = seed.weight;

  // Over-sample: some artists will yield nothing once filters run.
  const artistsNeeded = Math.ceil(constraints.targetLength / constraints.maxPerArtist);
  const sampleSize = Math.min(eligible.length, Math.ceil(artistsNeeded * 2.5));

  const coherent = selectCoherent(
    eligible
      .filter((artist) => weightOf(artist) > 0)
      .map((artist) => ({
        item: artist,
        tags: artist.tags ?? {},
        score: weightOf(artist),
      })),
    anchor,
    sampleSize,
    COHESION,
  );

  const coherentWeight = new Map(coherent.map((c) => [c.item.key, c.value]));

  // Sampling still happens, so two runs of the same request differ — but it now
  // draws from a coherent shortlist rather than the whole spread of the tag.
  const sampled = weightedSampleWithoutReplacement(
    coherent.map((c) => c.item),
    (artist) => coherentWeight.get(artist.key) ?? 0,
    sampleSize,
    rng,
  );

  if (sampled.length === 0) {
    return {
      tracks: [],
      warnings: ["No artists matched the requested styles closely enough."],
    };
  }

  const queues = new Map<string, Queue<EngineTrack>>();
  const reserves: EngineTrack[] = [];

  for (const artist of sampled) {
    const usable = artist.tracks.filter((track) => passesFilters(track, constraints));
    if (usable.length === 0) continue;

    const picked = selectTracksForBand(usable, constraints.obscurity, constraints.maxPerArtist);
    if (picked.length === 0) continue;

    const seedKey = dominantSeed(artist, seeds);
    const seedWeight = seeds.find((s) => s.tag === seedKey)?.weight ?? 1;

    let queue = queues.get(seedKey);
    if (!queue) {
      queue = { key: seedKey, weight: seedWeight, items: [] };
      queues.set(seedKey, queue);
    }
    queue.items.push(...picked);

    // Anything selected but not used is a candidate if we come up short.
    reserves.push(...usable.filter((track) => !picked.includes(track)));
  }

  for (const queue of queues.values()) {
    queue.items = capPerArtist(dedupeTracks(queue.items), constraints.maxPerArtist);
    // Each artist's picks were appended together above. Rotating them apart
    // here rather than leaving it to the repair pass is what keeps a 200-track
    // playlist as varied as a 25-track one — see roundRobinByKey.
    queue.items = roundRobinByKey(queue.items, (track) => track.artistKey);
  }

  const merged = interleave([...queues.values()], { maxRun: 3, rng });
  let tracks = capPerArtist(dedupeTracks(merged), constraints.maxPerArtist).slice(
    0,
    constraints.targetLength,
  );

  if (tracks.length < constraints.targetLength) {
    const filled = relaxToFill(
      tracks,
      dedupeTracks(reserves).filter((track) => passesFilters(track, constraints)),
      constraints.targetLength,
      constraints.maxPerArtist,
    );
    if (filled.tracks.length > tracks.length && filled.relaxedTo > constraints.maxPerArtist) {
      warnings.push(
        `Not enough distinct artists matched, so up to ${filled.relaxedTo} tracks per artist were allowed.`,
      );
    }
    tracks = filled.tracks.slice(0, constraints.targetLength);
  }

  tracks = separateAdjacent(tracks, (track) => track.artistKey);

  if (tracks.length < constraints.targetLength) {
    warnings.push(
      `Found ${tracks.length} of ${constraints.targetLength} tracks. Try widening the era, lowering the obscurity, or adding another style.`,
    );
  }

  return { tracks, warnings };
}
