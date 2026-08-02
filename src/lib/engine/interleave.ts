import type { Rng } from "./random";

/**
 * Ordering.
 *
 * Selection decides WHAT is in the playlist; this decides what it feels like.
 * A correct-but-clumped sequence (five shoegaze tracks, then five dream pop)
 * reads as two playlists stapled together, so queues are merged by weight with
 * a cap on how long any one queue may run.
 */

export interface Queue<T> {
  key: string;
  /** Relative share of the output. */
  weight: number;
  items: T[];
}

export interface InterleaveOptions {
  /** Longest permitted run from a single queue. */
  maxRun?: number;
  rng?: Rng;
}

/**
 * Weighted round-robin merge. Each queue accumulates credit proportional to its
 * weight; the queue with the most credit contributes the next item, unless it
 * has just hit its run limit.
 */
export function interleave<T>(
  queues: readonly Queue<T>[],
  options: InterleaveOptions = {},
): T[] {
  const { maxRun = 3, rng } = options;
  const active = queues
    .filter((q) => q.items.length > 0 && q.weight > 0)
    .map((q) => ({ ...q, items: q.items.slice(), credit: 0 }));

  if (active.length === 0) return [];
  if (active.length === 1) return active[0].items;

  const totalWeight = active.reduce((sum, q) => sum + q.weight, 0);
  const out: T[] = [];
  let lastKey: string | null = null;
  let run = 0;

  while (active.some((q) => q.items.length > 0)) {
    for (const queue of active) {
      queue.credit += queue.weight / totalWeight;
    }

    const eligible = active.filter((q) => {
      if (q.items.length === 0) return false;
      // Only enforce the run cap while another queue can actually take over.
      if (q.key === lastKey && run >= maxRun) {
        return !active.some((other) => other.key !== q.key && other.items.length > 0);
      }
      return true;
    });

    if (eligible.length === 0) break;

    let chosen = eligible[0];
    for (const queue of eligible) {
      if (queue.credit > chosen.credit) chosen = queue;
    }
    // Break ties randomly so equal-weight seeds don't always lead.
    if (rng) {
      const tied = eligible.filter((q) => Math.abs(q.credit - chosen.credit) < 1e-9);
      if (tied.length > 1) chosen = tied[Math.floor(rng() * tied.length)];
    }

    out.push(chosen.items.shift() as T);
    chosen.credit -= 1;

    run = chosen.key === lastKey ? run + 1 : 1;
    lastKey = chosen.key;
  }

  return out;
}

/**
 * Regroups a list so consecutive items rarely share a key, by emitting one item
 * per key in rotation.
 *
 * This exists because separateAdjacent is a repair pass, and a repair pass
 * scales badly: it makes a single forward sweep looking for a later item to
 * swap with, which works when a 25-track playlist has a handful of collisions
 * and fails on a 200-track one where every artist's picks arrived side by side
 * and the tail has nothing left to trade with. Distributing up front leaves
 * almost nothing to repair.
 *
 * Input order decides the rotation order, so a caller that sampled its items
 * randomly gets a random rotation.
 */
export function roundRobinByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const lists = [...groups.values()];
  let depth = 0;
  for (const list of lists) depth = Math.max(depth, list.length);

  const out: T[] = [];
  for (let round = 0; round < depth; round++) {
    for (const list of lists) {
      if (round < list.length) out.push(list[round]);
    }
  }

  return out;
}

/**
 * Reorders so the same artist never sits back-to-back, by swapping the
 * offending track with the nearest later one from a different artist.
 * Returns the input order when no legal arrangement exists (e.g. a two-artist
 * playlist that is mostly one of them).
 */
export function separateAdjacent<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const out = items.slice();

  for (let i = 1; i < out.length; i++) {
    if (keyOf(out[i]) !== keyOf(out[i - 1])) continue;

    let swapIndex = -1;
    for (let j = i + 1; j < out.length; j++) {
      const candidate = keyOf(out[j]);
      const nextOk = i + 1 >= out.length || candidate !== keyOf(out[i + 1]);
      if (candidate !== keyOf(out[i - 1]) && nextOk) {
        swapIndex = j;
        break;
      }
    }

    if (swapIndex !== -1) {
      [out[i], out[swapIndex]] = [out[swapIndex], out[i]];
    }
  }

  return out;
}

/**
 * Spaces a seed artist through a blend so they recur every `every` tracks
 * rather than front-loading. Used by "introduce me" blends, where the point is
 * to keep returning to the artist being introduced.
 */
export function distributeSeed<T>(
  seedItems: readonly T[],
  otherItems: readonly T[],
  every = 3,
): T[] {
  if (seedItems.length === 0) return otherItems.slice();
  if (otherItems.length === 0) return seedItems.slice();

  const out: T[] = [];
  const seeds = seedItems.slice();
  const others = otherItems.slice();

  // Open with the seed artist: the listener asked for them by name.
  out.push(seeds.shift() as T);

  while (seeds.length > 0 || others.length > 0) {
    for (let i = 0; i < every - 1 && others.length > 0; i++) {
      out.push(others.shift() as T);
    }
    if (seeds.length > 0) out.push(seeds.shift() as T);
    else if (others.length > 0) out.push(others.shift() as T);
  }

  return out;
}
