import { describe, expect, it } from "vitest";
import { blendedSimilarity, tagOverlap, weightedTagScore } from "./scoring";

describe("tagOverlap", () => {
  const radiohead = { "alternative rock": 1, "art rock": 0.8, experimental: 0.6 };

  it("returns 1 for identical tag sets", () => {
    expect(tagOverlap(radiohead, radiohead)).toBe(1);
  });

  it("returns 0 for disjoint tag sets", () => {
    expect(tagOverlap(radiohead, { "pop punk": 1, ska: 0.5 })).toBe(0);
  });

  it("scores a genuine neighbour above an unrelated act", () => {
    const artRock = { "art rock": 0.9, "alternative rock": 0.7, "post-rock": 0.4 };
    const popPunk = { "pop punk": 1, "punk rock": 0.8 };
    expect(tagOverlap(radiohead, artRock)).toBeGreaterThan(
      tagOverlap(radiohead, popPunk),
    );
  });

  it("respects tag weights rather than treating tags as a plain set", () => {
    // An artist barely tagged "pop" is not half a pop artist.
    const barely = { "alternative rock": 1, "art rock": 0.8, experimental: 0.6, pop: 0.02 };
    expect(tagOverlap(radiohead, barely)).toBeGreaterThan(0.9);
  });

  it("handles empty inputs without dividing by zero", () => {
    expect(tagOverlap({}, {})).toBe(0);
    expect(tagOverlap(radiohead, {})).toBe(0);
    expect(Number.isNaN(tagOverlap({}, radiohead))).toBe(false);
  });
});

describe("blendedSimilarity", () => {
  it("never zeroes a candidate purely for missing tags", () => {
    // Tag coverage is uneven; an untagged artist must stay reachable.
    for (const band of ["easy", "medium", "hard"] as const) {
      expect(blendedSimilarity(0.9, 0, band)).toBeGreaterThan(0);
    }
  });

  it("rewards genre agreement more as the request gets more adventurous", () => {
    const easy = blendedSimilarity(0.9, 1, "easy") - blendedSimilarity(0.9, 0, "easy");
    const hard = blendedSimilarity(0.9, 1, "hard") - blendedSimilarity(0.9, 0, "hard");
    expect(hard).toBeGreaterThan(easy);
  });

  it("lets a genre match overtake a stronger but unrelated co-listen", () => {
    const coListenedButUnrelated = blendedSimilarity(0.95, 0.05, "medium");
    const weakerButOnGenre = blendedSimilarity(0.6, 0.9, "medium");
    expect(weakerButOnGenre).toBeGreaterThan(coListenedButUnrelated);
  });

  it("leaves a perfect genre match at its original similarity", () => {
    expect(blendedSimilarity(0.8, 1, "hard")).toBeCloseTo(0.8);
  });
});

describe("weightedTagScore", () => {
  it("sums affinity across the requested seeds", () => {
    const affinity = { shoegaze: 0.8, "dream pop": 0.5 };
    expect(
      weightedTagScore(affinity, [
        { tag: "shoegaze", weight: 1 },
        { tag: "dream pop", weight: 0.5 },
      ]),
    ).toBeCloseTo(1.05);
  });

  it("ignores tags the artist does not carry", () => {
    expect(weightedTagScore({ shoegaze: 1 }, [{ tag: "techno", weight: 1 }])).toBe(0);
  });
});
