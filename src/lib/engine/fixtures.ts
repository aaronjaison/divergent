import { normalizeTitle } from "@/lib/text";
import type { EngineArtist, EngineTrack, StyleConstraints } from "./types";
import { DEFAULT_CONSTRAINTS } from "./types";

/** Test-only builders. Kept out of *.test.ts so several suites can share them. */

export function makeTrack(
  artistKey: string,
  title: string,
  overrides: Partial<EngineTrack> = {},
): EngineTrack {
  return {
    key: overrides.key ?? `${artistKey}:${normalizeTitle(title)}`,
    title,
    titleNorm: normalizeTitle(title),
    artistKey,
    artistNames: [artistKey],
    matchConfidence: "exact",
    durationMs: 210_000,
    ...overrides,
  };
}

/**
 * An artist with `trackCount` tracks whose popularity descends evenly from 100,
 * so band selection has a predictable distribution to slice.
 */
export function makeArtist(
  key: string,
  options: {
    popularity?: number;
    tags?: Record<string, number>;
    trackCount?: number;
    albums?: { title: string; year: number; trackCount: number }[];
  } = {},
): EngineArtist {
  const { popularity, tags = {}, trackCount = 10, albums } = options;

  const tracks: EngineTrack[] = [];

  if (albums) {
    for (const album of albums) {
      for (let i = 0; i < album.trackCount; i++) {
        tracks.push(
          makeTrack(key, `${album.title} Track ${i + 1}`, {
            album: album.title,
            albumKey: `${key}:${album.title}`,
            year: album.year,
            // Descending within each album so "hard" picks the tail.
            popularity: 100 - (i / Math.max(1, album.trackCount - 1)) * 100,
          }),
        );
      }
    }
  } else {
    for (let i = 0; i < trackCount; i++) {
      tracks.push(
        makeTrack(key, `${key} Song ${i + 1}`, {
          album: `${key} Album`,
          albumKey: `${key}:album`,
          year: 1990 + i,
          popularity: 100 - (i / Math.max(1, trackCount - 1)) * 100,
        }),
      );
    }
  }

  return { key, name: key, tagAffinity: tags, popularity, tracks };
}

export function constraints(
  overrides: Partial<StyleConstraints> = {},
): StyleConstraints {
  return { ...DEFAULT_CONSTRAINTS, seed: 1, ...overrides };
}
