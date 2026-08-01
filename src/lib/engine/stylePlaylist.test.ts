import { describe, expect, it } from "vitest";
import { artistDiversity, countByArtist } from "./diversity";
import { constraints, makeArtist } from "./fixtures";
import { generateStylePlaylist } from "./stylePlaylist";
import type { EngineArtist, WeightedTag } from "./types";

function pool(size: number, tag: string, prefix = "artist"): EngineArtist[] {
  return Array.from({ length: size }, (_, i) =>
    makeArtist(`${prefix}-${i}`, {
      // Spread popularity across the full range so bands have something to bite on.
      popularity: (i / Math.max(1, size - 1)) * 100,
      tags: { [tag]: 0.6 + (i % 5) * 0.08 },
      trackCount: 8,
    }),
  );
}

const shoegaze: WeightedTag[] = [{ tag: "shoegaze", weight: 1 }];

describe("generateStylePlaylist", () => {
  it("is deterministic for a given seed and varies with a different one", () => {
    const artists = pool(30, "shoegaze");
    const input = { seeds: shoegaze, artists, constraints: constraints({ seed: 42 }) };

    const first = generateStylePlaylist(input);
    const second = generateStylePlaylist(input);
    expect(second.tracks.map((t) => t.key)).toEqual(first.tracks.map((t) => t.key));

    const different = generateStylePlaylist({
      ...input,
      constraints: constraints({ seed: 43 }),
    });
    expect(different.tracks.map((t) => t.key)).not.toEqual(
      first.tracks.map((t) => t.key),
    );
  });

  it("never exceeds maxPerArtist when the pool is deep enough", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: pool(40, "shoegaze"),
      constraints: constraints({ targetLength: 25, maxPerArtist: 2 }),
    });

    expect(result.tracks).toHaveLength(25);
    for (const count of countByArtist(result.tracks).values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
    expect(result.warnings).toEqual([]);
  });

  it("keeps artist diversity high — the reason the app exists", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: pool(40, "shoegaze"),
      constraints: constraints({ targetLength: 25, maxPerArtist: 2 }),
    });
    expect(artistDiversity(result.tracks)).toBeGreaterThanOrEqual(0.5);
  });

  it("never places the same artist back to back", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: pool(40, "shoegaze"),
      constraints: constraints({ targetLength: 25, maxPerArtist: 2 }),
    });
    for (let i = 1; i < result.tracks.length; i++) {
      expect(result.tracks[i].artistKey).not.toBe(result.tracks[i - 1].artistKey);
    }
  });

  it("honours an era filter exactly", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: pool(40, "shoegaze"),
      constraints: constraints({ eraFrom: 1992, eraTo: 1995, targetLength: 10 }),
    });

    expect(result.tracks.length).toBeGreaterThan(0);
    for (const track of result.tracks) {
      expect(track.year).toBeGreaterThanOrEqual(1992);
      expect(track.year).toBeLessThanOrEqual(1995);
    }
  });

  it("mixes several seeds instead of exhausting one", () => {
    const artists = [...pool(15, "shoegaze"), ...pool(15, "dream pop", "dp")];
    const result = generateStylePlaylist({
      seeds: [
        { tag: "shoegaze", weight: 1 },
        { tag: "dream pop", weight: 1 },
      ],
      artists,
      constraints: constraints({ targetLength: 20 }),
    });

    const fromDreamPop = result.tracks.filter((t) => t.artistKey.startsWith("dp-"));
    expect(fromDreamPop.length).toBeGreaterThan(3);
    expect(fromDreamPop.length).toBeLessThan(result.tracks.length - 3);
  });

  it("warns rather than silently returning a short playlist", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: pool(2, "shoegaze"),
      constraints: constraints({ targetLength: 25, maxPerArtist: 2 }),
    });

    expect(result.tracks.length).toBeLessThan(25);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/of 25 tracks|per artist/);
  });

  it("returns a clear warning when nothing matches the seeds", () => {
    const result = generateStylePlaylist({
      seeds: [{ tag: "vaporwave", weight: 1 }],
      artists: pool(10, "shoegaze"),
      constraints: constraints(),
    });

    expect(result.tracks).toEqual([]);
    expect(result.warnings[0]).toMatch(/No artists/i);
  });

  it("handles an empty pool without throwing", () => {
    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists: [],
      constraints: constraints(),
    });
    expect(result.tracks).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("prefers obscure artists in hard mode and popular ones in easy mode", () => {
    const artists = pool(40, "shoegaze");
    const popularityOf = (key: string) =>
      artists.find((a) => a.key === key)?.popularity ?? 50;

    const easy = generateStylePlaylist({
      seeds: shoegaze,
      artists,
      constraints: constraints({ obscurity: "easy", targetLength: 20 }),
    });
    const hard = generateStylePlaylist({
      seeds: shoegaze,
      artists,
      constraints: constraints({ obscurity: "hard", targetLength: 20 }),
    });

    const mean = (keys: string[]) =>
      keys.reduce((sum, key) => sum + popularityOf(key), 0) / keys.length;

    expect(mean(easy.tracks.map((t) => t.artistKey))).toBeGreaterThan(
      mean(hard.tracks.map((t) => t.artistKey)),
    );
  });

  it("excludes live and remix titles", () => {
    const artists = pool(20, "shoegaze");
    artists[0].tracks.push({
      ...artists[0].tracks[0],
      key: "live-track",
      title: "Souvlaki Space Station (Live at Reading)",
      titleNorm: "souvlaki space station live at reading",
    });

    const result = generateStylePlaylist({
      seeds: shoegaze,
      artists,
      constraints: constraints({ targetLength: 25 }),
    });

    expect(result.tracks.some((t) => t.key === "live-track")).toBe(false);
  });
});
