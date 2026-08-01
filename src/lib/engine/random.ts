/**
 * Seeded RNG. Every generation stores its seed, so a playlist can be rebuilt
 * exactly (debugging, "regenerate") and "shuffle again" is just a new seed.
 */
export type Rng = () => number;

/** mulberry32: small, fast, good enough distribution for selection/shuffling. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turns a user-facing string (tags, artist mbid) into a stable numeric seed. */
export function seedFromString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fisher-Yates, non-mutating. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Weighted sampling without replacement, used to pick artists from a scored
 * pool. Weights <= 0 are skipped rather than treated as impossible-but-eligible,
 * so a caller that scores everything to zero gets an empty result, not a crash.
 */
export function weightedSampleWithoutReplacement<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  count: number,
  rng: Rng,
): T[] {
  const pool = items.filter((item) => weightOf(item) > 0);
  const weights = pool.map(weightOf);
  const picked: T[] = [];
  let total = weights.reduce((sum, w) => sum + w, 0);

  while (picked.length < count && pool.length > 0 && total > 0) {
    let threshold = rng() * total;
    let index = 0;
    while (index < pool.length - 1) {
      threshold -= weights[index];
      if (threshold <= 0) break;
      index++;
    }
    picked.push(pool[index]);
    total -= weights[index];
    pool.splice(index, 1);
    weights.splice(index, 1);
  }

  return picked;
}
