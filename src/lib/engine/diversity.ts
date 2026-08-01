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
): { tracks: EngineTrack[]; relaxedTo: number } {
  let tracks = selected.slice();
  let cap = maxPerArtist;

  const chosen = new Set(tracks.map((t) => t.key));
  const remaining = reserves.filter((t) => !chosen.has(t.key));

  while (tracks.length < targetLength && cap < maxPerArtist + 2) {
    cap++;
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
  }

  return { tracks, relaxedTo: cap };
}
