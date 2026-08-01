import { describe, expect, it } from "vitest";
import { makeTrack } from "./fixtures";
import {
  BANDS,
  bandAffinity,
  inBand,
  percentileRanks,
  selectTracksForBand,
} from "./obscurity";

describe("percentileRanks", () => {
  it("spreads distinct values across the full range", () => {
    expect(percentileRanks([10, 20, 30, 40, 50])).toEqual([0, 25, 50, 75, 100]);
  });

  it("puts a single value at the midpoint rather than an extreme", () => {
    expect(percentileRanks([42])).toEqual([50]);
  });

  it("gives tied values the same rank instead of ordering them arbitrarily", () => {
    // The whole pool being equally popular must not fabricate a hierarchy.
    expect(percentileRanks([5, 5, 5, 5])).toEqual([50, 50, 50, 50]);
    expect(percentileRanks([1, 2, 2, 3])).toEqual([0, 50, 50, 100]);
  });

  it("is order-independent with respect to the input", () => {
    expect(percentileRanks([50, 10, 30])).toEqual([100, 0, 50]);
  });

  it("handles an empty pool", () => {
    expect(percentileRanks([])).toEqual([]);
  });
});

describe("bands", () => {
  it("overlaps so thin pools do not starve", () => {
    // easy and medium share 60-75; medium and hard share 25-40.
    expect(inBand(70, "easy")).toBe(true);
    expect(inBand(70, "medium")).toBe(true);
    expect(inBand(30, "medium")).toBe(true);
    expect(inBand(30, "hard")).toBe(true);
  });

  it("still separates the extremes", () => {
    expect(inBand(95, "hard")).toBe(false);
    expect(inBand(5, "easy")).toBe(false);
  });

  it("scores in-band percentiles above out-of-band ones", () => {
    expect(bandAffinity(80, "easy")).toBeGreaterThan(bandAffinity(10, "easy"));
    expect(bandAffinity(10, "hard")).toBeGreaterThan(bandAffinity(90, "hard"));
  });

  it("never returns zero, so out-of-band artists remain usable as filler", () => {
    for (const band of Object.keys(BANDS) as (keyof typeof BANDS)[]) {
      for (const percentile of [0, 25, 50, 75, 100]) {
        expect(bandAffinity(percentile, band)).toBeGreaterThan(0);
      }
    }
  });
});

describe("selectTracksForBand", () => {
  const tracks = Array.from({ length: 10 }, (_, i) =>
    makeTrack("artist", `Song ${i + 1}`, { popularity: 100 - i * 10 }),
  );

  it("takes the hits for easy mode", () => {
    const picked = selectTracksForBand(tracks, "easy", 3);
    expect(picked.map((t) => t.popularity)).toEqual([100, 90, 80]);
  });

  it("takes the tail for hard mode", () => {
    const picked = selectTracksForBand(tracks, "hard", 3);
    for (const track of picked) {
      expect(track.popularity).toBeLessThanOrEqual(40);
    }
  });

  it("avoids both extremes in medium mode", () => {
    const picked = selectTracksForBand(tracks, "medium", 3);
    for (const track of picked) {
      expect(track.popularity).toBeLessThan(100);
      expect(track.popularity).toBeGreaterThan(10);
    }
  });

  it("refuses to claim fame it cannot verify", () => {
    // Unknown popularity is not the same as unpopular: easy and hard are both
    // explicit claims, so unranked tracks are only eligible for medium.
    const unranked = [
      makeTrack("a", "One"),
      makeTrack("a", "Two"),
      makeTrack("a", "Three"),
    ];
    expect(selectTracksForBand(unranked, "easy", 2)).toHaveLength(0);
    expect(selectTracksForBand(unranked, "hard", 2)).toHaveLength(0);
    expect(selectTracksForBand(unranked, "medium", 2)).toHaveLength(2);
  });

  it("returns nothing for an empty catalogue or a zero request", () => {
    expect(selectTracksForBand([], "easy", 5)).toEqual([]);
    expect(selectTracksForBand(tracks, "easy", 0)).toEqual([]);
  });

  it("never returns more than requested", () => {
    for (const band of ["easy", "medium", "hard"] as const) {
      expect(selectTracksForBand(tracks, band, 2).length).toBeLessThanOrEqual(2);
    }
  });
});
