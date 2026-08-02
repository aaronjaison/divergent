import { describe, expect, it } from "vitest";
import {
  distributeSeed,
  interleave,
  roundRobinByKey,
  separateAdjacent,
} from "./interleave";
import { createRng } from "./random";

interface Item {
  q: string;
  n: number;
}

function queue(key: string, count: number, weight = 1) {
  return {
    key,
    weight,
    items: Array.from({ length: count }, (_, n) => ({ q: key, n })),
  };
}

describe("interleave", () => {
  it("returns every item exactly once", () => {
    const merged = interleave([queue("a", 5), queue("b", 5), queue("c", 3)]);
    expect(merged).toHaveLength(13);
    expect(new Set(merged.map((i) => `${i.q}${i.n}`)).size).toBe(13);
  });

  it("preserves order within each queue", () => {
    const merged = interleave([queue("a", 5), queue("b", 5)]);
    const aOrder = merged.filter((i) => i.q === "a").map((i) => i.n);
    expect(aOrder).toEqual([0, 1, 2, 3, 4]);
  });

  it("respects the run cap while another queue still has items", () => {
    const merged = interleave([queue("a", 10), queue("b", 10)], { maxRun: 2 });

    let run = 1;
    for (let i = 1; i < merged.length; i++) {
      run = merged[i].q === merged[i - 1].q ? run + 1 : 1;
      // Once one queue empties the cap no longer applies, so only check while
      // both still have items left to contribute.
      const bothRemain =
        merged.slice(i).some((x) => x.q === "a") &&
        merged.slice(i).some((x) => x.q === "b");
      if (bothRemain) expect(run).toBeLessThanOrEqual(2);
    }
  });

  it("gives heavier queues a larger share of the opening stretch", () => {
    const merged = interleave([queue("heavy", 20, 3), queue("light", 20, 1)]);
    const firstTen = merged.slice(0, 10);
    expect(firstTen.filter((i) => i.q === "heavy").length).toBeGreaterThan(
      firstTen.filter((i) => i.q === "light").length,
    );
  });

  it("handles empty and single-queue inputs", () => {
    expect(interleave<Item>([])).toEqual([]);
    expect(interleave([queue("a", 0), queue("b", 0)])).toEqual([]);
    expect(interleave([queue("solo", 3)])).toHaveLength(3);
  });

  it("ignores zero-weight queues rather than looping forever", () => {
    const merged = interleave([queue("a", 3), queue("ignored", 3, 0)]);
    expect(merged.every((i) => i.q === "a")).toBe(true);
  });

  it("is deterministic for a given rng seed", () => {
    const build = () =>
      interleave([queue("a", 5), queue("b", 5)], { rng: createRng(9) });
    expect(build()).toEqual(build());
  });
});

describe("separateAdjacent", () => {
  it("breaks up neighbouring duplicates when an alternative exists", () => {
    const items = ["a", "a", "b", "c", "c", "d"];
    const result = separateAdjacent(items, (x) => x);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]).not.toBe(result[i - 1]);
    }
  });

  it("keeps every element", () => {
    const items = ["a", "a", "b", "b", "c"];
    const result = separateAdjacent(items, (x) => x);
    expect(result.slice().sort()).toEqual(items.slice().sort());
  });

  it("returns the input unchanged when no arrangement can help", () => {
    const items = ["a", "a", "a"];
    expect(separateAdjacent(items, (x) => x)).toEqual(items);
  });
});

describe("distributeSeed", () => {
  it("opens with the seed and spaces it out", () => {
    const seeds = ["s1", "s2", "s3"];
    const others = ["o1", "o2", "o3", "o4", "o5", "o6"];
    const result = distributeSeed(seeds, others, 3);

    expect(result[0]).toBe("s1");
    expect(result).toHaveLength(9);

    const positions = result
      .map((item, index) => (item.startsWith("s") ? index : -1))
      .filter((index) => index >= 0);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(4);
    }
  });

  it("handles either side being empty", () => {
    expect(distributeSeed([], ["a", "b"], 3)).toEqual(["a", "b"]);
    expect(distributeSeed(["s"], [], 3)).toEqual(["s"]);
  });

  it("drains both lists completely", () => {
    const result = distributeSeed(["s1", "s2"], ["o1", "o2", "o3"], 2);
    expect(result.slice().sort()).toEqual(["o1", "o2", "o3", "s1", "s2"]);
  });
});

describe("roundRobinByKey", () => {
  const keyOf = (item: string) => item.split(":")[0];

  it("separates a list where each key's items arrived together", () => {
    const input = ["a:1", "a:2", "b:1", "b:2", "c:1", "c:2"];
    const result = roundRobinByKey(input, keyOf);

    for (let i = 1; i < result.length; i++) {
      expect(keyOf(result[i])).not.toBe(keyOf(result[i - 1]));
    }
  });

  it("keeps every item exactly once", () => {
    const input = ["a:1", "a:2", "a:3", "b:1", "c:1", "c:2"];
    const result = roundRobinByKey(input, keyOf);
    expect(result.slice().sort()).toEqual(input.slice().sort());
  });

  it("preserves each key's internal order", () => {
    const input = ["a:1", "a:2", "a:3", "b:1", "b:2"];
    const result = roundRobinByKey(input, keyOf).filter((i) => keyOf(i) === "a");
    expect(result).toEqual(["a:1", "a:2", "a:3"]);
  });

  it("rotates in order of first appearance, so a random input stays random", () => {
    const result = roundRobinByKey(["c:1", "a:1", "b:1", "c:2", "a:2"], keyOf);
    expect(result).toEqual(["c:1", "a:1", "b:1", "c:2", "a:2"]);
  });

  it("tolerates a single key and an empty list", () => {
    expect(roundRobinByKey(["a:1", "a:2"], keyOf)).toEqual(["a:1", "a:2"]);
    expect(roundRobinByKey([], keyOf)).toEqual([]);
  });

  it("scales: 150 keys with two items each never repeat back to back", () => {
    const input = Array.from({ length: 150 }, (_, i) => [`k${i}:1`, `k${i}:2`]).flat();
    const result = roundRobinByKey(input, keyOf);

    expect(result).toHaveLength(300);
    for (let i = 1; i < result.length; i++) {
      expect(keyOf(result[i])).not.toBe(keyOf(result[i - 1]));
    }
  });
});
