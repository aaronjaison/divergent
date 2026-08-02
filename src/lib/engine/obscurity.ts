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
 * Selects from a similarity-ranked list at the depth the band implies.
 *
 * The top of a co-listening similarity list is dominated by whoever is most
 * listened to overall — ask for artists like Radiohead and the first answers
 * are Nirvana, Coldplay and the Beatles. Those are true co-listens and useless
 * recommendations, since anyone asking already knows them. Skipping the head
 * of the list is what turns similarity into discovery.
 *
 * 'easy' keeps the obvious neighbours, which is the right answer for someone
 * who wants a gentle way in.
 */
export function selectByDepth<T>(
  ranked: readonly T[],
  band: ObscurityBand,
  count: number,
): T[] {
  if (ranked.length === 0 || count <= 0) return [];

  const skipFraction = band === "easy" ? 0 : band === "medium" ? 0.15 : 0.35;
  let start = Math.floor(ranked.length * skipFraction);

  // Never skip so far that we cannot fill the request.
  start = Math.min(start, Math.max(0, ranked.length - count));

  return ranked.slice(start, start + count);
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

  // The band as a window onto the popularity-ordered catalogue.
  let start: number;
  let end: number;
  switch (band) {
    case "easy":
      start = 0;
      end = Math.max(count, Math.ceil(sorted.length * 0.34));
      break;
    case "medium":
      start = Math.floor(sorted.length * 0.25);
      end = Math.max(start + count, Math.ceil(sorted.length * 0.75));
      break;
    case "hard":
      start = Math.floor(sorted.length * 0.6);
      end = sorted.length;
      break;
  }

  const picked = sorted.slice(start, end);
  if (picked.length >= count) return picked.slice(0, count);

  /**
   * The window is a FRACTION of the catalogue, so on its own it cannot answer
   * a request larger than that fraction: 'hard' offers the bottom 40%, which
   * means asking for 70 tracks from a 98-track catalogue returned 39 and the
   * playlist came up short. That reads to the listener as "we could not find
   * enough music" when the truth is "you asked for more than this slice
   * holds".
   *
   * So the window widens outward from its own edges instead, nearest first.
   * The band still decides what comes first and therefore what survives being
   * trimmed to length; it just stops being a hard boundary once the request
   * outgrows it.
   */
  const out = picked.slice();
  const above = sorted.slice(0, start).reverse();
  const below = sorted.slice(end);

  let a = 0;
  let b = 0;
  while (out.length < count && (a < below.length || b < above.length)) {
    // Outward past the obscure edge first: a band that ran out is still a
    // request for less-familiar music, and what lies below it honours that
    // better than the hits sitting above.
    if (a < below.length) out.push(below[a++]);
    if (out.length < count && b < above.length) out.push(above[b++]);
  }

  // Medium makes no claim about fame in either direction, so a track of
  // unknown popularity is legitimate filler there and nowhere else.
  if (out.length < count && band === "medium") out.push(...unranked);

  return out.slice(0, count);
}
