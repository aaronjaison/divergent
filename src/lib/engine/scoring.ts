import type { ObscurityBand } from "./types";

/**
 * Cross-checking co-listening similarity against genre.
 *
 * Session-based similarity answers "who else do these listeners play?", which
 * is not the same question as "who sounds like this?". For a widely-played
 * artist the two diverge badly: ask for artists like Radiohead and you get
 * Green Day and Daft Punk — genuinely co-listened, sonically unrelated, and
 * useless to someone who wants to hear something new.
 *
 * Weighting similarity by genre overlap fixes that without discarding the
 * co-listening signal, which is still the best evidence that two artists
 * belong in the same playlist.
 */

/**
 * Weighted Jaccard overlap of two tag sets, 0-1.
 *
 * Weighted rather than plain set overlap because tag strength carries real
 * information: an artist tagged "art rock" at 1.0 and "pop" at 0.05 is not
 * half a pop artist.
 */
export function tagOverlap(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;

  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const left = a[key] ?? 0;
    const right = b[key] ?? 0;
    intersection += Math.min(left, right);
    union += Math.max(left, right);
  }

  return union > 0 ? intersection / union : 0;
}

/**
 * Blends co-listening similarity with genre overlap.
 *
 * Overlap never fully vetoes a candidate: tag coverage is uneven, and an
 * artist with no tags at all would otherwise be unreachable. In 'easy' mode
 * the weighting is deliberately gentle, because someone asking for a gentle
 * introduction is well served by the obvious co-listens.
 */
export function blendedSimilarity(
  similarity: number,
  overlap: number,
  band: ObscurityBand,
): number {
  const genreWeight = band === "easy" ? 0.3 : band === "medium" ? 0.6 : 0.75;
  return similarity * (1 - genreWeight + genreWeight * overlap);
}

/** Sum of an artist's affinity for a set of weighted tags. */
export function weightedTagScore(
  affinity: Readonly<Record<string, number>>,
  seeds: readonly { tag: string; weight: number }[],
): number {
  return seeds.reduce(
    (sum, seed) => sum + (affinity[seed.tag] ?? 0) * seed.weight,
    0,
  );
}
