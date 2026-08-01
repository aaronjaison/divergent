import { describe, expect, it } from "vitest";
import {
  normalizeArtistName,
  normalizeIsrc,
  normalizeTitle,
  stringSimilarity,
} from "./text";

describe("normalizeTitle", () => {
  it("collapses reissue and remaster suffixes to the same key", () => {
    const base = normalizeTitle("Paranoid Android");
    expect(normalizeTitle("Paranoid Android (2009 Remaster)")).toBe(base);
    expect(normalizeTitle("Paranoid Android - 2009 Remaster")).toBe(base);
    expect(normalizeTitle("Paranoid Android [Remastered Version]")).toBe(base);
    expect(normalizeTitle("Paranoid Android (Album Version)")).toBe(base);
  });

  it("strips featured-artist parentheticals", () => {
    expect(normalizeTitle("Bad Guy (feat. Justin Bieber)")).toBe(
      normalizeTitle("Bad Guy"),
    );
    expect(normalizeTitle("Bad Guy (featuring Someone)")).toBe(
      normalizeTitle("Bad Guy"),
    );
  });

  it("folds accents, punctuation and ampersands", () => {
    expect(normalizeTitle("Café Bleu")).toBe(normalizeTitle("Cafe Bleu"));
    expect(normalizeTitle("Don't Look Back")).toBe(normalizeTitle("Dont Look Back"));
    expect(normalizeTitle("Salt & Pepper")).toBe(normalizeTitle("Salt and Pepper"));
  });

  it("keeps genuinely different titles distinct", () => {
    expect(normalizeTitle("Creep")).not.toBe(normalizeTitle("Creep Show"));
    // A remix is a different recording, so it must survive normalisation.
    expect(normalizeTitle("Teardrop (Mad Professor Remix)")).not.toBe(
      normalizeTitle("Teardrop"),
    );
  });
});

describe("normalizeArtistName", () => {
  it("ignores a leading 'the'", () => {
    expect(normalizeArtistName("The Beatles")).toBe(normalizeArtistName("Beatles"));
  });

  it("does not strip 'the' from the middle of a name", () => {
    expect(normalizeArtistName("Bat for Lashes")).toBe("bat for lashes");
  });
});

describe("stringSimilarity", () => {
  it("returns 1 for equivalent titles after normalisation", () => {
    expect(stringSimilarity("Creep", "creep")).toBe(1);
    expect(stringSimilarity("Karma Police", "Karma Police (2009 Remaster)")).toBe(1);
  });

  it("scores near-misses high and unrelated strings low", () => {
    expect(stringSimilarity("Radiohead", "Radiohed")).toBeGreaterThan(0.85);
    expect(stringSimilarity("Radiohead", "Portishead")).toBeLessThan(0.7);
  });

  it("handles empty input without dividing by zero", () => {
    expect(stringSimilarity("", "Creep")).toBe(0);
    expect(Number.isNaN(stringSimilarity("", ""))).toBe(false);
  });
});

describe("normalizeIsrc", () => {
  it("strips separators and upper-cases", () => {
    expect(normalizeIsrc("gb-ayе-99-00001")).toBeUndefined();
    expect(normalizeIsrc("us-qe9-21-00257")).toBe("USQE92100257");
    expect(normalizeIsrc("usqe92100257")).toBe("USQE92100257");
  });

  it("rejects values that are not ISRC-shaped", () => {
    expect(normalizeIsrc("not-an-isrc")).toBeUndefined();
    expect(normalizeIsrc("")).toBeUndefined();
    expect(normalizeIsrc(undefined)).toBeUndefined();
    expect(normalizeIsrc(null)).toBeUndefined();
  });
});
