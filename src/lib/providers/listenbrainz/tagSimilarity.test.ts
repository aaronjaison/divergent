import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenBrainzTags, mapSimilarTags } from "./tagSimilarity";

const stub = vi.hoisted(() => ({
  cacheKeys: [] as string[],
  urls: [] as string[],
  response: null as unknown,
  commercialLicense: false,
}));

vi.mock("@/lib/config", () => ({
  config: {
    get metabrainzCommercialLicense() {
      return stub.commercialLicense;
    },
  },
}));

vi.mock("@/lib/cache/cachedFetch", () => ({
  TTL: {
    similarity: { fresh: 1, stale: 2 },
    tags: { fresh: 1, stale: 2 },
    permanent: { fresh: 1, stale: 2 },
  },
  cachedFetch: (
    key: string,
    _provider: string,
    _ttl: unknown,
    fetcher: () => Promise<unknown>,
  ) => {
    stub.cacheKeys.push(key);
    return fetcher();
  },
}));

vi.mock("@/lib/net/httpClient", () => ({
  qs: (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      search.set(key, String(value));
    }
    return search.toString();
  },
  providerFetch: (_provider: string, url: string) => {
    stub.urls.push(url);
    return Promise.resolve(stub.response);
  },
}));

/** Real /tag-similarity response for `shoegaze`, head and tail of 27 rows. */
const SHOEGAZE_RESPONSE = [
  { similar_tag: "ethereal wave", count: 1388 },
  { similar_tag: "slowcore", count: 974 },
  { similar_tag: "math rock", count: 540 },
  { similar_tag: "psych", count: 390 },
  { similar_tag: "garage", count: 290 },
  { similar_tag: "instrumental rock", count: 242 },
  { similar_tag: "english", count: 96 },
  { similar_tag: "uk", count: 80 },
  { similar_tag: "70s", count: 10 },
  { similar_tag: "60s", count: 8 },
];

/** Real rows for `slowcore` — a much lower ceiling than shoegaze's. */
const SLOWCORE_RESPONSE = [
  { similar_tag: "bedroom pop", count: 128 },
  { similar_tag: "slacker rock", count: 124 },
  { similar_tag: "post-hardcore", count: 122 },
  { similar_tag: "noise rock", count: 120 },
  { similar_tag: "ethereal wave", count: 82 },
  { similar_tag: "lofi", count: 60 },
];

beforeEach(() => {
  stub.cacheKeys.length = 0;
  stub.urls.length = 0;
  stub.response = null;
  stub.commercialLicense = false;
});

describe("mapSimilarTags", () => {
  it("normalises count against the response max", () => {
    const result = mapSimilarTags(SHOEGAZE_RESPONSE, "shoegaze", 50);

    expect(result[0]).toEqual({ tag: "ethereal wave", score: 1 });
    expect(result[1].score).toBeCloseTo(974 / 1388, 10);
    expect(result.at(-1)?.score).toBeCloseTo(8 / 1388, 10);
  });

  it("puts a low-ceiling tag on the same scale as a high-ceiling one", () => {
    const shoegaze = mapSimilarTags(SHOEGAZE_RESPONSE, "shoegaze", 50);
    const slowcore = mapSimilarTags(SLOWCORE_RESPONSE, "slowcore", 50);

    expect(shoegaze[0].score).toBe(1);
    expect(slowcore[0].score).toBe(1);
    expect(slowcore[1].score).toBeCloseTo(124 / 128, 10);
  });

  it("excludes the seed tag", () => {
    const withSeed = [
      { similar_tag: "shoegaze", count: 4000 },
      ...SHOEGAZE_RESPONSE,
    ];

    const result = mapSimilarTags(withSeed, "  Shoegaze ", 50);

    expect(result.map((entry) => entry.tag)).not.toContain("shoegaze");
    // The seed was the largest count; dropping it must re-base the scale.
    expect(result[0]).toEqual({ tag: "ethereal wave", score: 1 });
  });

  it("gives every tag 1 when all counts are equal", () => {
    const flat = SLOWCORE_RESPONSE.map((row) => ({ ...row, count: 12 }));

    const result = mapSimilarTags(flat, "slowcore", 50);

    expect(result.map((entry) => entry.score)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("does not divide by zero when every count is zero", () => {
    const zeroed = SLOWCORE_RESPONSE.map((row) => ({ ...row, count: 0 }));

    const result = mapSimilarTags(zeroed, "slowcore", 50);

    expect(result).toHaveLength(6);
    for (const entry of result) {
      expect(entry.score).toBe(0);
    }
  });

  it("skips malformed rows and non-array payloads", () => {
    const messy = [
      null,
      42,
      { similar_tag: "", count: 10 },
      { similar_tag: "no count" },
      { similar_tag: "string count", count: "50" },
      { count: 10 },
      { similar_tag: "dream pop", count: 200 },
    ];

    expect(mapSimilarTags(messy, "shoegaze", 50)).toEqual([
      { tag: "dream pop", score: 1 },
    ]);
    expect(mapSimilarTags(null, "shoegaze", 50)).toEqual([]);
    expect(mapSimilarTags({ detail: "bad request" }, "shoegaze", 50)).toEqual([]);
  });

  it("slices to the limit, best first", () => {
    const result = mapSimilarTags(SHOEGAZE_RESPONSE, "shoegaze", 3);

    expect(result.map((entry) => entry.tag)).toEqual([
      "ethereal wave",
      "slowcore",
      "math rock",
    ]);
  });
});

describe("listenBrainzTags.getSimilarTags", () => {
  it("lowercases the query, because the endpoint matches literally", async () => {
    stub.response = SHOEGAZE_RESPONSE;

    const result = await listenBrainzTags.getSimilarTags("  Shoegaze  ", 4);

    expect(stub.urls[0]).toBe(
      "https://labs.api.listenbrainz.org/tag-similarity/json?tag=shoegaze",
    );
    expect(stub.cacheKeys[0]).toBe("lb_labs:tag-similarity:tag=shoegaze");
    expect(result.data).toHaveLength(4);
    expect(result.source).toBe("lb_labs");
  });

  // Load-bearing: these tags are MusicBrainz's (CC BY-NC-SA), not ListenBrainz's
  // own, so unlike similar-artists they must not be stamped 'open' — the
  // pre-launch purge selects on exactly this field.
  it("stamps tag rows noncommercial, not open", async () => {
    stub.response = SHOEGAZE_RESPONSE;

    const result = await listenBrainzTags.getSimilarTags("shoegaze");

    expect(result.licenseClass).toBe("noncommercial");
  });

  it("upgrades to licensed under a MetaBrainz tier", async () => {
    stub.commercialLicense = true;
    stub.response = SHOEGAZE_RESPONSE;

    const result = await listenBrainzTags.getSimilarTags("shoegaze");

    expect(result.licenseClass).toBe("licensed");
  });

  it("returns empty without calling out for a blank tag", async () => {
    const result = await listenBrainzTags.getSimilarTags("   ");

    expect(result.data).toEqual([]);
    expect(result.licenseClass).toBe("noncommercial");
    expect(stub.urls).toEqual([]);
  });

  it("treats the 200-with-empty-array miss as no neighbours", async () => {
    stub.response = [];

    const result = await listenBrainzTags.getSimilarTags("not a real tag");

    expect(result.data).toEqual([]);
  });
});
