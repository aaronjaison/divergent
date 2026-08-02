import { describe, expect, it } from "vitest";
import {
  artistDiversity,
  capPerArtist,
  countByArtist,
  relaxToFill,
} from "./diversity";
import { makeTrack } from "./fixtures";

/** `count` tracks by one artist, distinctly keyed. */
function tracksBy(artist: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeTrack(artist, `${artist} Song ${i + 1}`),
  );
}

describe("capPerArtist", () => {
  it("keeps the first N from each artist and drops the rest", () => {
    const result = capPerArtist([...tracksBy("a", 5), ...tracksBy("b", 3)], 2);
    expect(countByArtist(result)).toEqual(new Map([["a", 2], ["b", 2]]));
  });

  it("preserves order", () => {
    const input = [...tracksBy("a", 2), ...tracksBy("b", 2)];
    expect(capPerArtist(input, 2).map((t) => t.title)).toEqual(
      input.map((t) => t.title),
    );
  });
});

describe("artistDiversity", () => {
  it("is 1 when no artist repeats and 0 for an empty list", () => {
    expect(artistDiversity([...tracksBy("a", 1), ...tracksBy("b", 1)])).toBe(1);
    expect(artistDiversity([])).toBe(0);
    expect(artistDiversity(tracksBy("a", 4))).toBe(0.25);
  });
});

describe("relaxToFill", () => {
  it("fills within the cap before relaxing anything", () => {
    // One track each from three artists, cap of 2 — there is a whole track per
    // artist still available inside the promise.
    const selected = [
      tracksBy("a", 2)[0],
      tracksBy("b", 2)[0],
      tracksBy("c", 2)[0],
    ];
    const reserves = [...tracksBy("a", 2), ...tracksBy("b", 2), ...tracksBy("c", 2)];

    const { tracks, relaxedTo } = relaxToFill(selected, reserves, 6, 2);

    expect(tracks).toHaveLength(6);
    // Nothing was relaxed, so nothing should be reported as relaxed.
    expect(relaxedTo).toBe(2);
    for (const count of countByArtist(tracks).values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it("relaxes one step at a time and reports how far it went", () => {
    const selected = [...tracksBy("a", 2)];
    const reserves = tracksBy("a", 6);

    const { tracks, relaxedTo } = relaxToFill(selected, reserves, 3, 2);

    expect(tracks).toHaveLength(3);
    expect(relaxedTo).toBe(3);
  });

  it("never relaxes past two steps", () => {
    const { tracks, relaxedTo } = relaxToFill([], tracksBy("a", 20), 20, 1);

    expect(relaxedTo).toBe(3);
    expect(tracks).toHaveLength(3);
  });

  it("honours maxRelaxation 0 by refusing to exceed the cap", () => {
    const selected = [tracksBy("a", 3)[0]];
    const reserves = tracksBy("a", 3);

    const { tracks, relaxedTo } = relaxToFill(selected, reserves, 10, 2, 0);

    // Filled to the cap, then stopped rather than breaking it.
    expect(tracks).toHaveLength(2);
    expect(relaxedTo).toBe(2);
  });

  it("never duplicates a track already selected", () => {
    const shared = tracksBy("a", 3);
    const { tracks } = relaxToFill(shared.slice(0, 2), shared, 3, 5);

    expect(new Set(tracks.map((t) => t.key)).size).toBe(tracks.length);
  });

  it("returns the input untouched when there is nothing in reserve", () => {
    const selected = tracksBy("a", 2);
    const { tracks, relaxedTo } = relaxToFill(selected, [], 10, 2);

    expect(tracks).toHaveLength(2);
    expect(relaxedTo).toBe(2);
  });
});
