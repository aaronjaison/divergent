import type { EngineTrack } from "./types";

/**
 * The anti-repetition rule, and the reason this app exists: a discovery
 * playlist that leans on three artists is just a shorter version of what the
 * listener already plays.
 */

export function capPerArtist(
  tracks: readonly EngineTrack[],
  maxPerArtist: number,
): EngineTrack[] {
  const counts = new Map<string, number>();
  const out: EngineTrack[] = [];

  for (const track of tracks) {
    const used = counts.get(track.artistKey) ?? 0;
    if (used >= maxPerArtist) continue;
    counts.set(track.artistKey, used + 1);
    out.push(track);
  }

  return out;
}

export function countByArtist(tracks: readonly EngineTrack[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    counts.set(track.artistKey, (counts.get(track.artistKey) ?? 0) + 1);
  }
  return counts;
}

/** How many distinct artists appear per track — 1.0 means no artist repeats. */
export function artistDiversity(tracks: readonly EngineTrack[]): number {
  if (tracks.length === 0) return 0;
  return countByArtist(tracks).size / tracks.length;
}

/**
 * Fills a shortfall by relaxing the per-artist cap one step at a time, rather
 * than jumping straight to "anything goes". Returning 18 of 25 requested
 * tracks is a worse outcome than a third appearance from a couple of artists,
 * but only just — so the relaxation is gradual and reported to the caller.
 */
export function relaxToFill(
  selected: readonly EngineTrack[],
  reserves: readonly EngineTrack[],
  targetLength: number,
  maxPerArtist: number,
  /**
   * How far above `maxPerArtist` the cap may go. Zero means fill only within
   * the cap — used where the caller has made the cap a promise rather than a
   * preference, such as a blend, where exceeding it turns "and friends" back
   * into the single-artist playlist the listener was trying to escape.
   */
  maxRelaxation = 2,
): { tracks: EngineTrack[]; relaxedTo: number } {
  const tracks = selected.slice();
  const chosen = new Set(tracks.map((t) => t.key));
  const remaining = reserves.filter((t) => !chosen.has(t.key));

  let cap = maxPerArtist;
  /** The highest cap that actually contributed a track, so the caller only
   * reports a relaxation that really happened. */
  let usedCap = maxPerArtist;

  // The first pass runs at the caller's own cap, not above it. Callers often
  // allocate fewer tracks per artist than the cap permits — a blend spreading
  // 65 slots over 50 artists gives nearly all of them one — so there is
  // usually room left inside the promise before any of it needs breaking.
  while (tracks.length < targetLength) {
    const before = tracks.length;
    const counts = countByArtist(tracks);

    for (const track of remaining) {
      if (tracks.length >= targetLength) break;
      if (chosen.has(track.key)) continue;
      const used = counts.get(track.artistKey) ?? 0;
      if (used >= cap) continue;

      counts.set(track.artistKey, used + 1);
      chosen.add(track.key);
      tracks.push(track);
    }

    if (tracks.length > before) usedCap = cap;
    if (tracks.length >= targetLength || cap >= maxPerArtist + maxRelaxation) break;
    cap++;
  }

  return { tracks, relaxedTo: usedCap };
}
