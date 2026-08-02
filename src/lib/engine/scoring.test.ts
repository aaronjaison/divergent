import { describe, expect, it } from "vitest";
import type { CoherenceCandidate } from "./scoring";
import {
  rankByGenreThenSimilarity,
  coherence,
  selectCoherent,
  tagCentroid,
  tagCosine,
  tagOverlap,
  tagSpecificity,
  weightedTagScore,
} from "./scoring";

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

describe("rankByGenreThenSimilarity", () => {
  /**
   * The measurement that killed the multiplicative version this replaced.
   * Asked who is like PinkPantheress, ListenBrainz puts The Weeknd first on
   * co-listening with almost no genre agreement, while the genuinely correct
   * answer sits a long way down. Any multiplier keeps The Weeknd on top,
   * because a superstar's co-listening score is an order of magnitude larger
   * than an underground artist's and a fractional penalty cannot close it.
   */
  const REAL_CASE = [
    { name: "The Weeknd", similarity: 1.0, fit: 0.029 },
    { name: "beabadoobee", similarity: 0.949, fit: 0.003 },
    { name: "Tyler, The Creator", similarity: 0.871, fit: 0.0 },
    { name: "Billie Eilish", similarity: 0.656, fit: 0.065 },
    { name: "Magdalena Bay", similarity: 0.397, fit: 0.153 },
    { name: "Machine Girl", similarity: 0.271, fit: 0.261 },
    { name: "Nia Archives", similarity: 0.223, fit: 0.294 },
  ];

  const rank = (band: "easy" | "medium" | "hard") => {
    const scores = rankByGenreThenSimilarity(REAL_CASE, band);
    return REAL_CASE.map((c, i) => ({ name: c.name, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .map((c) => c.name);
  };

  it("puts the on-genre artist above the superstar co-listen", () => {
    const order = rank("medium");
    expect(order.indexOf("Nia Archives")).toBeLessThan(order.indexOf("The Weeknd"));
    expect(order.indexOf("Machine Girl")).toBeLessThan(order.indexOf("beabadoobee"));
  });

  it("leans harder on genre the more adventurous the request", () => {
    expect(rank("hard").indexOf("Nia Archives")).toBeLessThanOrEqual(
      rank("easy").indexOf("Nia Archives"),
    );
  });

  it("still favours the obvious neighbours in easy mode", () => {
    const order = rank("easy");
    // Not last: someone asking for a gentle way in is well served by them.
    expect(order.indexOf("The Weeknd")).toBeLessThan(REAL_CASE.length - 1);
  });

  it("keeps similarity as the tiebreak when genre fit is level", () => {
    const scores = rankByGenreThenSimilarity(
      [
        { similarity: 0.2, fit: 0.5 },
        { similarity: 0.9, fit: 0.5 },
      ],
      "medium",
    );
    expect(scores[1]).toBeGreaterThan(scores[0]);
  });

  it("handles empty and single-candidate input", () => {
    expect(rankByGenreThenSimilarity([], "medium")).toEqual([]);
    expect(rankByGenreThenSimilarity([{ similarity: 0.5, fit: 0.5 }], "medium")).toEqual([1]);
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

/**
 * Real MusicBrainz tag profiles, captured 2026-08-02, normalised by each
 * artist's own maximum the way mergeTags does. These two are the reference
 * case for genre coherence: both are broadly "rap adjacent" and pair terribly.
 */
const PINKPANTHERESS = {
  "uk garage": 1,
  "drum and bass": 0.75,
  jungle: 0.5,
  "alternative pop": 0.5,
  pop: 0.5,
  "future garage": 0.5,
  "dance-pop": 0.25,
  "bubblegum pop": 0.25,
  "2020s": 0.25,
  "gen z": 0.25,
};

const DENZEL_CURRY = {
  "hip hop": 1,
  trap: 0.71,
  "conscious hip hop": 0.43,
  "hardcore hip hop": 0.43,
  rap: 0.29,
  "southern hip hop": 0.29,
  "trap metal": 0.14,
  underground: 0.14,
  "alternative hip hop": 0.01,
  "pop rap": 0.01,
  drill: 0.01,
};

const JPEGMAFIA = {
  "experimental hip hop": 1,
  "hip hop": 0.8,
  "industrial hip hop": 0.7,
  "hardcore hip hop": 0.5,
  rap: 0.4,
  underground: 0.3,
};

describe("tagSpecificity", () => {
  it("discounts umbrella categories that two unlike artists both sit under", () => {
    expect(tagSpecificity("hip hop")).toBeLessThan(tagSpecificity("trap metal"));
    expect(tagSpecificity("rock")).toBeLessThan(tagSpecificity("shoegaze"));
    expect(tagSpecificity("electronic")).toBeLessThan(tagSpecificity("future garage"));
  });

  it("ignores tags that say nothing about how the music sounds", () => {
    for (const tag of ["2020s", "1990s", "80s", "seen live", "british", "gen z"]) {
      expect(tagSpecificity(tag)).toBe(0);
    }
  });

  it("is case and whitespace insensitive", () => {
    expect(tagSpecificity("  Hip Hop ")).toBe(tagSpecificity("hip hop"));
  });
});

describe("tagOverlap specificity weighting", () => {
  it("does not treat a shared umbrella tag as evidence of similarity", () => {
    // Both are rap-adjacent; neither sounds remotely like the other. The
    // mismatch has to score at nothing while a real subgenre neighbour does not.
    expect(tagOverlap(DENZEL_CURRY, PINKPANTHERESS)).toBe(0);
    expect(tagOverlap(DENZEL_CURRY, JPEGMAFIA)).toBeGreaterThan(0.15);
  });

  it("scores a same-scene pair far above a same-umbrella pair", () => {
    const sameScene = tagCosine(DENZEL_CURRY, JPEGMAFIA);
    const sameUmbrella = tagCosine(DENZEL_CURRY, PINKPANTHERESS);
    expect(sameScene).toBeGreaterThan(0.2);
    expect(sameUmbrella).toBe(0);
  });
});

describe("tagCosine", () => {
  it("keeps its range as a centroid accumulates tags", () => {
    // The reason coherence uses cosine and not Jaccard: a centroid drawn from
    // a long playlist carries a long playlist's worth of tags, and a
    // union-based metric would sink every candidate towards zero with it.
    const shoegaze = { shoegaze: 1, "dream pop": 0.8 };
    const wide: Record<string, number> = { shoegaze: 1, "dream pop": 0.8 };
    for (let i = 0; i < 60; i++) wide[`other-genre-${i}`] = 0.2;

    expect(tagCosine(shoegaze, wide)).toBeGreaterThan(tagOverlap(shoegaze, wide));
    expect(tagCosine(shoegaze, wide)).toBeGreaterThan(0.5);
  });

  it("is 1 for identical profiles and 0 for disjoint ones", () => {
    const a = { shoegaze: 1, "dream pop": 0.5 };
    expect(tagCosine(a, a)).toBeCloseTo(1);
    expect(tagCosine(a, { trap: 1 })).toBe(0);
    expect(tagCosine(a, {})).toBe(0);
  });

  it("is 0 when a profile contains only tags that carry no signal", () => {
    expect(tagCosine({ "2020s": 1, british: 1 }, { shoegaze: 1 })).toBe(0);
  });
});

describe("tagCentroid", () => {
  it("averages profiles in proportion to their weight", () => {
    const centroid = tagCentroid([
      { tags: { trap: 1 }, weight: 3 },
      { tags: { "uk garage": 1 }, weight: 1 },
    ]);
    expect(centroid.trap).toBeGreaterThan(centroid["uk garage"]);
  });

  it("ignores empty profiles and zero weights", () => {
    expect(tagCentroid([{ tags: {}, weight: 5 }])).toEqual({});
    expect(tagCentroid([{ tags: { trap: 1 }, weight: 0 }])).toEqual({});
    expect(tagCentroid([])).toEqual({});
  });
});

describe("coherence", () => {
  it("treats an unknown profile as neutral, never as a mismatch", () => {
    // Tag coverage thins out below the famous; scoring absence as "does not
    // belong" would exclude exactly the artists this app exists to surface.
    expect(coherence({}, DENZEL_CURRY)).toBe(0.5);
    expect(coherence(DENZEL_CURRY, {})).toBe(0.5);
  });
});

describe("selectCoherent", () => {
  const trapish = (i: number) => ({ "hip hop": 1, trap: 0.9, drill: 0.5 - i * 0.01 });
  const garagey = (i: number) => ({ "uk garage": 1, "future garage": 0.8, pop: 0.4 - i * 0.01 });

  it("picks a lane instead of sampling both sides of a broad genre", () => {
    // An even split of two incompatible styles, all equally similar. Choosing
    // by score alone would return roughly half of each.
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => ({
        item: `trap-${i}`,
        tags: trapish(i),
        score: 0.8,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        item: `garage-${i}`,
        tags: garagey(i),
        score: 0.8,
      })),
    ];

    const picked = selectCoherent(candidates, { "hip hop": 1, rap: 1 }, 8, 0.65);
    const trapCount = picked.filter((p) => p.item.startsWith("trap")).length;

    expect(trapCount).toBeGreaterThanOrEqual(7);
  });

  it("still respects the prior score when everything fits equally", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      item: `a-${i}`,
      tags: { shoegaze: 1 },
      score: (5 - i) / 5,
    }));

    const picked = selectCoherent(candidates, { shoegaze: 1 }, 5, 0.6);
    expect(picked.map((p) => p.item)).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4"]);
  });

  it("is a plain score sort at zero cohesion", () => {
    const candidates: CoherenceCandidate<string>[] = [
      { item: "low", tags: { shoegaze: 1 }, score: 0.1 },
      { item: "high", tags: { polka: 1 }, score: 0.9 },
    ];
    const picked = selectCoherent(candidates, { shoegaze: 1 }, 2, 0);
    expect(picked[0].item).toBe("high");
  });

  it("does not drop untagged candidates", () => {
    const candidates: CoherenceCandidate<string>[] = [
      { item: "tagged", tags: { shoegaze: 1 }, score: 0.5 },
      { item: "untagged", tags: {}, score: 0.5 },
    ];
    const picked = selectCoherent(candidates, { shoegaze: 1 }, 2, 0.65);
    expect(picked.map((p) => p.item).sort()).toEqual(["tagged", "untagged"]);
  });

  it("returns everything when asked for more than it has", () => {
    const candidates = [{ item: "a", tags: { shoegaze: 1 }, score: 1 }];
    expect(selectCoherent(candidates, {}, 50, 0.6)).toHaveLength(1);
  });

  it("handles empty input and a zero request", () => {
    expect(selectCoherent([], { shoegaze: 1 }, 5, 0.6)).toEqual([]);
    expect(
      selectCoherent([{ item: "a", tags: {}, score: 1 }], {}, 0, 0.6),
    ).toEqual([]);
  });
});
