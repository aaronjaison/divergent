import { afterEach, describe, expect, it, vi } from "vitest";
import { mbTagLicense } from "./client";
import { rankArtistsForTag, tagQuery } from "./tags";

// Pure helpers in a module that transitively imports the cache; stub the
// driver so a unit test never opens SQLite.
vi.mock("@/lib/db/client", () => ({ db: {}, schema: {} }));

/**
 * Trimmed from live captures (2026-08-01): /ws/2/artist?query=tag:shoegaze and
 * the equivalent for tag:"dream pop". Tag lists are cut to the entries the
 * assertions use, counts left exactly as returned.
 */
const SHOEGAZE_SEARCH = {
  created: "2026-08-01T22:01:44.117Z",
  count: 1349,
  offset: 0,
  artists: [
    {
      id: "ba0d6274-db14-4ef5-b28d-657ebde1a396",
      type: "Group",
      score: 100,
      name: "The Smashing Pumpkins",
      "sort-name": "Smashing Pumpkins, The",
      country: "US",
      "life-span": { begin: "1988", ended: null },
      tags: [
        { count: 5, name: "shoegaze" },
        { count: 12, name: "alternative rock" },
      ],
    },
    {
      id: "39ab1aed-75e0-4140-bd47-540276886b60",
      type: "Group",
      score: 92,
      name: "Oasis",
      "sort-name": "Oasis",
      country: "GB",
      disambiguation: "Noel & Liam Gallagher",
      "life-span": { begin: "1991", ended: null },
      tags: [
        { count: 0, name: "shoegaze" },
        { count: 9, name: "britpop" },
      ],
    },
    {
      id: "ba853904-ae25-4ebb-89d6-c44cfbd71bd2",
      type: "Group",
      score: 87,
      name: "Blur",
      "sort-name": "Blur",
      country: "GB",
      disambiguation: "UK alternative rock band",
      "life-span": { begin: "1990", ended: null },
      tags: [{ count: 2, name: "shoegaze" }],
    },
    {
      id: "e938a15c-b17e-4e7a-9f68-ff0d536cab44",
      type: "Group",
      score: 83,
      name: "The Jesus and Mary Chain",
      "sort-name": "Jesus and Mary Chain, The",
      country: "GB",
      "life-span": { begin: "1984", ended: null },
      tags: [{ count: 6, name: "shoegaze" }],
    },
    {
      id: "37e3dd97-73f9-4c69-b50d-0c0e3c47c40c",
      type: "Group",
      score: 82,
      name: "Catherine Wheel",
      "sort-name": "Catherine Wheel",
      country: "GB",
      disambiguation: "UK shoegaze / alternative rock band",
      "life-span": { begin: "1990-04", end: "2000", ended: true },
      tags: [{ count: 3, name: "shoegaze" }],
    },
  ],
} as const;

const DREAM_POP_SEARCH = {
  count: 1058,
  offset: 0,
  artists: [
    {
      id: "ba0d6274-db14-4ef5-b28d-657ebde1a396",
      score: 100,
      name: "The Smashing Pumpkins",
      country: "US",
      "life-span": { begin: "1988", ended: null },
      tags: [{ count: 6, name: "dream pop" }],
    },
    {
      id: "cc197bad-dc9c-440d-a5b5-d52ba2e14234",
      score: 91,
      name: "Coldplay",
      country: "GB",
      "life-span": { begin: "1996-09", ended: null },
      tags: [{ count: 1, name: "dream pop" }],
    },
    {
      id: "ccda046a-2674-4f7d-97e6-f23d6c156432",
      score: 88,
      name: "Dead Can Dance",
      country: "AU",
      "life-span": { begin: "1981", ended: null },
      tags: [{ count: 0, name: "dream pop" }],
    },
  ],
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("tagQuery", () => {
  it("quotes multi-word tags", () => {
    // Unquoted this becomes tag:dream plus a free-text pop, which matches a
    // different and much worse set of artists.
    expect(tagQuery("dream pop")).toBe('tag:"dream pop"');
  });

  it("quotes single-word tags too, so callers have one code path", () => {
    expect(tagQuery("shoegaze")).toBe('tag:"shoegaze"');
    expect(tagQuery("  shoegaze  ")).toBe('tag:"shoegaze"');
  });

  it("escapes characters that would end the quoted phrase", () => {
    expect(tagQuery('rock "n" roll')).toBe('tag:"rock \\"n\\" roll"');
    expect(tagQuery("ac\\dc")).toBe('tag:"ac\\\\dc"');
  });
});

describe("rankArtistsForTag", () => {
  it("ranks on the artist's own tag count, not on MB's relevance", () => {
    // MB returns Smashing Pumpkins (5 votes) first and Oasis (0) second; the
    // Jesus and Mary Chain has the most shoegaze votes of the five.
    const ranked = rankArtistsForTag(SHOEGAZE_SEARCH.artists, "shoegaze");
    expect(ranked.map((artist) => artist.name)).toEqual([
      "The Jesus and Mary Chain",
      "The Smashing Pumpkins",
      "Catherine Wheel",
      "Blur",
      "Oasis",
    ]);
  });

  it("normalises the strongest tag holder to 1 and keeps everything in 0-1", () => {
    const ranked = rankArtistsForTag(SHOEGAZE_SEARCH.artists, "shoegaze");
    expect(ranked[0].score).toBeCloseTo(0.9 + 0.83 * 0.1, 5);
    for (const artist of ranked) {
      expect(artist.score).toBeGreaterThanOrEqual(0);
      expect(artist.score).toBeLessThanOrEqual(1);
    }
  });

  it("pushes a high-relevance artist with no votes to the bottom", () => {
    // Coldplay scores 91 on a single dream-pop vote; Dead Can Dance 88 on none.
    const ranked = rankArtistsForTag(DREAM_POP_SEARCH.artists, "dream pop");
    expect(ranked.map((artist) => artist.name)).toEqual([
      "The Smashing Pumpkins",
      "Coldplay",
      "Dead Can Dance",
    ]);
    expect(ranked[2].score).toBeLessThan(0.15);
  });

  it("matches the tag case- and whitespace-insensitively", () => {
    const ranked = rankArtistsForTag(SHOEGAZE_SEARCH.artists, "  Shoegaze ");
    expect(ranked[0].name).toBe("The Jesus and Mary Chain");
  });

  it("falls back to relevance order when no result carries the tag", () => {
    const ranked = rankArtistsForTag(SHOEGAZE_SEARCH.artists, "vaporwave");
    expect(ranked.map((artist) => artist.name)).toEqual([
      "The Smashing Pumpkins",
      "Oasis",
      "Blur",
      "The Jesus and Mary Chain",
      "Catherine Wheel",
    ]);
    expect(ranked[0].score).toBe(1);
  });

  it("keeps the descriptive fields the picker needs", () => {
    const ranked = rankArtistsForTag(SHOEGAZE_SEARCH.artists, "shoegaze");
    const catherineWheel = ranked.find((artist) => artist.name === "Catherine Wheel");
    expect(catherineWheel).toMatchObject({
      mbid: "37e3dd97-73f9-4c69-b50d-0c0e3c47c40c",
      country: "GB",
      disambiguation: "UK shoegaze / alternative rock band",
      beginYear: 1990,
      endYear: 2000,
    });
  });

  it("skips unusable entries instead of failing the page", () => {
    const ranked = rankArtistsForTag(
      [null, { id: "x" }, SHOEGAZE_SEARCH.artists[0]],
      "shoegaze",
    );
    expect(ranked).toHaveLength(1);
    expect(rankArtistsForTag(undefined, "shoegaze")).toEqual([]);
    expect(rankArtistsForTag([], "shoegaze")).toEqual([]);
  });
});

describe("mbTagLicense", () => {
  it("marks tag-derived data non-commercial by default", () => {
    expect(mbTagLicense()).toBe("noncommercial");
  });

  it("marks it licensed once a MetaBrainz tier is active", async () => {
    // config reads the environment at module load, so the flag has to be set
    // before the module graph is rebuilt.
    vi.stubEnv("METABRAINZ_COMMERCIAL_LICENSE", "true");
    vi.resetModules();
    const reloaded = await import("./client");
    expect(reloaded.mbTagLicense()).toBe("licensed");
  });
});
