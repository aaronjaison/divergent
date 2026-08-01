import type { EngineTrack, ObscurityBand } from "./types";

/**
 * Obscurity banding.
 *
 * The idea is borrowed from ListenBrainz's troi easy/medium/hard modes: rather
 * than a hard popularity cutoff, slice an ordered list at different depths.
 *
 * Percentiles are always computed WITHIN the candidate pool, never globally.
 * A pool of Norwegian black metal artists has a completely different absolute
 * popularity distribution from a pool of stadium rock artists; ranking within
 * the pool is what lets "hard" mean something in both.
 */

export interface Band {
  min: number;
  max: number;
}

/**
 * Bands overlap deliberately. Non-overlapping thirds starve the pool whenever
 * a tag has few artists, and produce jarringly uniform playlists when it has many.
 */
export const BANDS: Record<ObscurityBand, Band> = {
  easy: { min: 60, max: 100 },
  medium: { min: 25, max: 75 },
  hard: { min: 0, max: 40 },
};

/**
 * Percentile rank of each value, 0-100. Ties share the midpoint of the ranks
 * they span, so a pool where every artist has identical popularity lands
 * everyone at 50 rather than spuriously ordering them.
 */
export function percentileRanks(values: readonly number[]): number[] {
  const count = values.length;
  if (count === 0) return [];
  if (count === 1) return [50];

  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(count);
  let position = 0;

  while (position < count) {
    let end = position;
    while (end + 1 < count && indexed[end + 1].value === indexed[position].value) {
      end++;
    }
    // Midpoint of the tied span, mapped onto 0-100.
    const midpoint = (position + end) / 2;
    const percentile = (midpoint / (count - 1)) * 100;
    for (let i = position; i <= end; i++) {
      ranks[indexed[i].index] = percentile;
    }
    position = end + 1;
  }

  return ranks;
}

export function inBand(percentile: number, band: ObscurityBand): boolean {
  const { min, max } = BANDS[band];
  return percentile >= min && percentile <= max;
}

/**
 * How strongly a percentile suits a band. Peaks at the band's centre and
 * decays to a small non-zero floor outside it, so out-of-band candidates are
 * used as filler when the pool is thin instead of failing the generation.
 */
export function bandAffinity(percentile: number, band: ObscurityBand): number {
  const { min, max } = BANDS[band];
  if (percentile >= min && percentile <= max) {
    const centre = (min + max) / 2;
    const halfWidth = (max - min) / 2 || 1;
    const distance = Math.abs(percentile - centre) / halfWidth;
    return 1 - 0.4 * distance;
  }
  const overshoot = percentile < min ? min - percentile : percentile - max;
  return Math.max(0.05, 0.6 - overshoot / 100);
}

/**
 * Picks tracks from one artist at the depth the band implies: the hits for
 * 'easy', album-track territory for 'medium', the bottom of the catalogue for
 * 'hard'.
 *
 * Tracks with unknown popularity are only eligible for 'medium'. 'easy' and
 * 'hard' are explicit claims about how well-known something is, and an
 * unranked track cannot honour either.
 */
export function selectTracksForBand(
  tracks: readonly EngineTrack[],
  band: ObscurityBand,
  count: number,
): EngineTrack[] {
  if (tracks.length === 0 || count <= 0) return [];

  const ranked = tracks.filter((t) => t.popularity !== undefined);
  const unranked = tracks.filter((t) => t.popularity === undefined);

  if (ranked.length === 0) {
    return band === "medium" ? unranked.slice(0, count) : [];
  }

  const sorted = ranked
    .slice()
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

  let slice: EngineTrack[];
  switch (band) {
    case "easy":
      slice = sorted.slice(0, Math.max(count, Math.ceil(sorted.length * 0.34)));
      break;
    case "medium": {
      const start = Math.floor(sorted.length * 0.25);
      const end = Math.max(start + count, Math.ceil(sorted.length * 0.75));
      slice = sorted.slice(start, end);
      // Medium tolerates unknown popularity; it makes no fame claim either way.
      if (slice.length < count) slice = slice.concat(unranked);
      break;
    }
    case "hard": {
      const start = Math.floor(sorted.length * 0.6);
      slice = sorted.slice(start);
      break;
    }
  }

  if (slice.length === 0) slice = sorted;
  return slice.slice(0, count);
}
