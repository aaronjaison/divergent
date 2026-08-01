import { describe, expect, it } from "vitest";
import {
  createRng,
  seedFromString,
  shuffle,
  weightedSampleWithoutReplacement,
} from "./random";

describe("createRng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = Array.from({ length: 10 }, createRng(1));
    const b = Array.from({ length: 10 }, createRng(2));
    expect(a).not.toEqual(b);
  });

  it("stays within [0, 1)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 1000; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("seedFromString", () => {
  it("is stable and case-sensitive", () => {
    expect(seedFromString("shoegaze")).toBe(seedFromString("shoegaze"));
    expect(seedFromString("shoegaze")).not.toBe(seedFromString("Shoegaze"));
  });
});

describe("shuffle", () => {
  it("preserves every element and leaves the input untouched", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = shuffle(input, createRng(7));
    expect(result).toHaveLength(input.length);
    expect([...result].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("weightedSampleWithoutReplacement", () => {
  const items = [
    { id: "a", w: 10 },
    { id: "b", w: 5 },
    { id: "c", w: 1 },
  ];

  it("never repeats an item", () => {
    const picked = weightedSampleWithoutReplacement(
      items,
      (i) => i.w,
      3,
      createRng(3),
    );
    expect(new Set(picked.map((p) => p.id)).size).toBe(3);
  });

  it("stops when the pool runs out rather than looping forever", () => {
    const picked = weightedSampleWithoutReplacement(
      items,
      (i) => i.w,
      99,
      createRng(4),
    );
    expect(picked).toHaveLength(3);
  });

  it("skips zero and negative weights", () => {
    const picked = weightedSampleWithoutReplacement(
      [
        { id: "keep", w: 1 },
        { id: "zero", w: 0 },
        { id: "negative", w: -5 },
      ],
      (i) => i.w,
      3,
      createRng(5),
    );
    expect(picked.map((p) => p.id)).toEqual(["keep"]);
  });

  it("favours heavier items over many trials", () => {
    let heavyFirst = 0;
    for (let seed = 0; seed < 200; seed++) {
      const [first] = weightedSampleWithoutReplacement(
        items,
        (i) => i.w,
        1,
        createRng(seed),
      );
      if (first.id === "a") heavyFirst++;
    }
    // 'a' holds 10/16 of the weight; allow slack for a small sample.
    expect(heavyFirst).toBeGreaterThan(100);
  });
});
