import { describe, expect, it } from "vitest";
import { makeTrack } from "./fixtures";
import {
  BANDS,
  bandAffinity,
  inBand,
  percentileRanks,
  selectByDepth,
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

describe("selectByDepth", () => {
  const ranked = Array.from({ length: 100 }, (_, i) => ({ id: i }));

  it("keeps the obvious neighbours in easy mode", () => {
    expect(selectByDepth(ranked, "easy", 5).map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("skips the head of the list in medium and hard mode", () => {
    // The top of a co-listening list is whoever is most listened to overall —
    // true co-listens, useless recommendations.
    expect(selectByDepth(ranked, "medium", 5)[0].id).toBeGreaterThan(0);
    expect(selectByDepth(ranked, "hard", 5)[0].id).toBeGreaterThan(
      selectByDepth(ranked, "medium", 5)[0].id,
    );
  });

  it("never skips so far that it cannot fill the request", () => {
    const short = Array.from({ length: 6 }, (_, i) => ({ id: i }));
    for (const band of ["easy", "medium", "hard"] as const) {
      expect(selectByDepth(short, band, 5)).toHaveLength(5);
    }
  });

  it("returns what it can from a list smaller than the request", () => {
    const tiny = [{ id: 0 }, { id: 1 }];
    expect(selectByDepth(tiny, "hard", 5)).toHaveLength(2);
  });

  it("handles empty input and zero counts", () => {
    expect(selectByDepth([], "easy", 5)).toEqual([]);
    expect(selectByDepth(ranked, "easy", 0)).toEqual([]);
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

  it("widens past the band rather than returning short", () => {
    // 'hard' is the bottom 40% of the catalogue, so a request for 8 of these
    // 10 tracks cannot be answered from inside the band. Coming up 4 short
    // reads as "we could not find your music" when the truth is "you asked for
    // more than that slice holds".
    const big = Array.from({ length: 100 }, (_, i) =>
      makeTrack("artist", `Song ${i + 1}`, { popularity: 100 - i }),
    );

    for (const band of ["easy", "medium", "hard"] as const) {
      expect(selectTracksForBand(big, band, 80)).toHaveLength(80);
    }
  });

  it("keeps the band's own tracks when it has to widen", () => {
    const big = Array.from({ length: 100 }, (_, i) =>
      makeTrack("artist", `Song ${i + 1}`, { popularity: 100 - i }),
    );

    const picked = selectTracksForBand(big, "hard", 80);
    // Every track from inside the band survives; the extras come from outside.
    const inBand = big.slice(60);
    for (const track of inBand) {
      expect(picked).toContain(track);
    }
  });

  it("widens downward from easy and upward from hard", () => {
    const big = Array.from({ length: 100 }, (_, i) =>
      makeTrack("artist", `Song ${i + 1}`, { popularity: 100 - i }),
    );

    const hard = selectTracksForBand(big, "hard", 60);
    const easy = selectTracksForBand(big, "easy", 60);

    const mean = (list: typeof big) =>
      list.reduce((sum, t) => sum + (t.popularity ?? 0), 0) / list.length;

    // Even widened, the bands still mean opposite things.
    expect(mean(hard)).toBeLessThan(mean(easy));
  });

  it("still cannot invent tracks that do not exist", () => {
    expect(selectTracksForBand(tracks, "hard", 500)).toHaveLength(10);
  });
});
