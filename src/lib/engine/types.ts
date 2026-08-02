/**
 * Engine-local types.
 *
 * This module and everything beside it is PURE: no imports from providers/,
 * db/ or net/. The engine receives an assembled pool and returns an ordered
 * tracklist, which is what makes the whole selection algorithm unit-testable
 * without a network or a database.
 */

export type ObscurityBand = "easy" | "medium" | "hard";

/** How confidently a track was matched across sources. */
export type MatchConfidence = "isrc" | "exact" | "fuzzy" | "none";

export interface EngineTrack {
  /** Stable identity for dedupe. Usually recording mbid, else artist+titleNorm. */
  key: string;
  title: string;
  titleNorm: string;
  /** Pool-local artist key; ties a track back to its EngineArtist. */
  artistKey: string;
  artistNames: string[];
  album?: string;
  albumKey?: string;
  year?: number;
  durationMs?: number;
  isrc?: string;
  recordingMbid?: string;
  /**
   * 0-100 popularity, normalised within its source. Undefined means unknown,
   * which is different from unpopular and must never be treated as zero.
   */
  popularity?: number;
  matchConfidence: MatchConfidence;
  /** User-facing explanation, e.g. "deep cut from Kid A (2000)". */
  reason?: string;
}

export interface EngineArtist {
  key: string;
  mbid?: string;
  name: string;
  /** tag name -> 0-1 affinity. */
  tagAffinity: Record<string, number>;
  /** 0-100 within-source popularity; undefined when no provider matched. */
  popularity?: number;
  tracks: EngineTrack[];
}

export interface StyleConstraints {
  targetLength: number;
  /** Hard cap on how often one artist may appear — the anti-repetition rule. */
  maxPerArtist: number;
  obscurity: ObscurityBand;
  eraFrom?: number;
  eraTo?: number;
  /** Deterministic RNG seed, persisted so a playlist can be rebuilt exactly. */
  seed: number;
  /** Minimum/maximum track length, filtering interludes and side-long pieces. */
  minDurationMs?: number;
  maxDurationMs?: number;
}

/**
 * The longest playlist we will build. Set by Soundiiz's import endpoint, which
 * rejects anything over 200 tracks — building more would produce a playlist
 * that cannot reach the streaming service it was made for.
 */
export const MAX_PLAYLIST_LENGTH = 200;

export const DEFAULT_CONSTRAINTS = {
  targetLength: 25,
  maxPerArtist: 2,
  obscurity: "medium",
  minDurationMs: 60_000,
  maxDurationMs: 12 * 60_000,
} as const satisfies Partial<StyleConstraints>;

export interface GeneratedPlaylist {
  tracks: EngineTrack[];
  warnings: string[];
}

export interface WeightedTag {
  tag: string;
  /** 0-1. Expanded (neighbour) tags arrive discounted. */
  weight: number;
}
