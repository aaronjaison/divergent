import { beforeEach, describe, expect, it, vi } from "vitest";
import { listenBrainzSimilarity, mapSimilarArtists } from "./similarity";

const stub = vi.hoisted(() => ({
  cacheKeys: [] as string[],
  urls: [] as string[],
  response: null as unknown,
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

const DUSTER_MBID = "879d43c6-13a8-42f6-b8df-a9b7d50aa9e2";
const RADIOHEAD_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

/** Real /similar-artists rows for Duster, trimmed; the self row is #68 of 100. */
const DUSTER_RESPONSE = [
  {
    artist_mbid: "a16371b9-7d36-497a-a9d4-42b0a0440c5e",
    name: "Slowdive",
    comment: "",
    type: "Group",
    gender: null,
    score: 825,
    reference_mbid: DUSTER_MBID,
  },
  {
    artist_mbid: RADIOHEAD_MBID,
    name: "Radiohead",
    comment: "",
    type: "Group",
    gender: null,
    score: 720,
    reference_mbid: DUSTER_MBID,
  },
  {
    artist_mbid: "8ca01f46-53ac-4af2-8516-55a909c0905e",
    name: "My Bloody Valentine",
    comment: "Irish shoegaze band",
    type: "Group",
    gender: null,
    score: 716,
    reference_mbid: DUSTER_MBID,
  },
  {
    artist_mbid: DUSTER_MBID,
    name: "Duster",
    comment: "US indie rock band",
    type: "Group",
    gender: null,
    score: 193,
    reference_mbid: null,
  },
  {
    artist_mbid: "04482c2e-88ab-4709-a412-85748b7ac825",
    name: "Cap’n Jazz",
    comment: "",
    type: "Group",
    gender: null,
    score: 161,
    reference_mbid: DUSTER_MBID,
  },
];

/** Real rows for Radiohead — note the scale is an order of magnitude larger. */
const RADIOHEAD_RESPONSE = [
  {
    artist_mbid: "5b11f4ce-a62d-471e-81fc-a69a8278c7da",
    name: "Nirvana",
    comment: "1980s–1990s US grunge band",
    type: "Group",
    gender: null,
    score: 11156,
    reference_mbid: RADIOHEAD_MBID,
  },
  {
    artist_mbid: "5441c29d-3602-4898-b1a1-b77fa23b8e50",
    name: "David Bowie",
    comment: "English singer‐songwriter",
    type: "Person",
    gender: "Male",
    score: 8852,
    reference_mbid: RADIOHEAD_MBID,
  },
  {
    artist_mbid: "a66999a7-ae5c-460e-ba94-1a01143ae847",
    name: "Snow Patrol",
    comment: "",
    type: "Group",
    gender: null,
    score: 4223,
    reference_mbid: RADIOHEAD_MBID,
  },
];

beforeEach(() => {
  stub.cacheKeys.length = 0;
  stub.urls.length = 0;
  stub.response = null;
});

describe("mapSimilarArtists", () => {
  it("normalises against the response max so the top neighbour is 1", () => {
    const result = mapSimilarArtists(DUSTER_RESPONSE, DUSTER_MBID, 50);

    expect(result[0]).toEqual({
      mbid: "a16371b9-7d36-497a-a9d4-42b0a0440c5e",
      name: "Slowdive",
      disambiguation: undefined,
      score: 1,
    });
    expect(result.at(-1)?.score).toBeCloseTo(161 / 825, 10);
    for (const entry of result) {
      expect(entry.score).toBeGreaterThan(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  it("puts seeds of wildly different popularity on the same scale", () => {
    const duster = mapSimilarArtists(DUSTER_RESPONSE, DUSTER_MBID, 50);
    const radiohead = mapSimilarArtists(RADIOHEAD_RESPONSE, RADIOHEAD_MBID, 50);

    expect(duster[0].score).toBe(1);
    expect(radiohead[0].score).toBe(1);
    expect(radiohead[2].score).toBeCloseTo(4223 / 11156, 10);
  });

  it("drops the seed even though it is neither first nor last", () => {
    const result = mapSimilarArtists(DUSTER_RESPONSE, DUSTER_MBID, 50);

    expect(result).toHaveLength(4);
    expect(result.map((entry) => entry.name)).not.toContain("Duster");
    expect(result.map((entry) => entry.mbid)).not.toContain(DUSTER_MBID);
  });

  it("matches the seed case-insensitively", () => {
    const result = mapSimilarArtists(
      DUSTER_RESPONSE,
      DUSTER_MBID.toUpperCase(),
      50,
    );

    expect(result.map((entry) => entry.name)).not.toContain("Duster");
  });

  it("maps an empty comment to undefined and keeps a real one", () => {
    const result = mapSimilarArtists(RADIOHEAD_RESPONSE, RADIOHEAD_MBID, 50);

    expect(result[1].disambiguation).toBe("English singer‐songwriter");
    expect(result[2].disambiguation).toBeUndefined();
  });

  it("gives every entry 1 when all scores are equal", () => {
    const flat = DUSTER_RESPONSE.map((row) => ({ ...row, score: 400 }));

    const result = mapSimilarArtists(flat, DUSTER_MBID, 50);

    expect(result.map((entry) => entry.score)).toEqual([1, 1, 1, 1]);
  });

  it("does not divide by zero when every score is zero", () => {
    const zeroed = DUSTER_RESPONSE.map((row) => ({ ...row, score: 0 }));

    const result = mapSimilarArtists(zeroed, DUSTER_MBID, 50);

    expect(result).toHaveLength(4);
    for (const entry of result) {
      expect(Number.isFinite(entry.score)).toBe(true);
      expect(entry.score).toBe(0);
    }
  });

  it("skips malformed rows instead of throwing", () => {
    const messy = [
      null,
      "not a row",
      [],
      { name: "No mbid", score: 10 },
      { artist_mbid: "x", score: 10 },
      { artist_mbid: "y", name: "No score" },
      { artist_mbid: "z", name: "Bad score", score: "700" },
      { artist_mbid: "w", name: "NaN score", score: Number.NaN },
      DUSTER_RESPONSE[0],
    ];

    const result = mapSimilarArtists(messy, DUSTER_MBID, 50);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Slowdive");
  });

  it("returns empty for a non-array payload", () => {
    expect(mapSimilarArtists(null, DUSTER_MBID, 50)).toEqual([]);
    expect(mapSimilarArtists({ error: "nope" }, DUSTER_MBID, 50)).toEqual([]);
    expect(mapSimilarArtists([], DUSTER_MBID, 50)).toEqual([]);
  });

  it("slices to the limit, best first", () => {
    const result = mapSimilarArtists(DUSTER_RESPONSE, DUSTER_MBID, 2);

    expect(result.map((entry) => entry.name)).toEqual([
      "Slowdive",
      "Radiohead",
    ]);
  });
});

describe("listenBrainzSimilarity.getSimilarArtists", () => {
  it("returns an empty sourced result without calling out when the mbid is missing", async () => {
    const result = await listenBrainzSimilarity.getSimilarArtists({
      name: "Duster",
    });

    expect(result.data).toEqual([]);
    expect(result.source).toBe("lb_labs");
    expect(result.licenseClass).toBe("open");
    expect(stub.urls).toEqual([]);
  });

  it("sends the algorithm and keys the cache on it", async () => {
    stub.response = DUSTER_RESPONSE;

    const result = await listenBrainzSimilarity.getSimilarArtists(
      { mbid: DUSTER_MBID.toUpperCase(), name: "Duster" },
      3,
    );

    expect(stub.urls[0]).toContain(
      "https://labs.api.listenbrainz.org/similar-artists/json?",
    );
    expect(stub.urls[0]).toContain(`artist_mbids=${DUSTER_MBID}`);
    expect(stub.urls[0]).toContain("algorithm=session_based_days_7500");
    expect(stub.cacheKeys[0]).toBe(
      `lb_labs:similar-artists:algorithm=session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30&artist_mbids=${DUSTER_MBID}`,
    );
    expect(result.data).toHaveLength(3);
    expect(result.data[0].name).toBe("Slowdive");
  });

  it("treats the 200-with-empty-array miss as no neighbours", async () => {
    stub.response = [];

    const result = await listenBrainzSimilarity.getSimilarArtists({
      mbid: "00000000-0000-0000-0000-000000000000",
      name: "Unknown",
    });

    expect(result.data).toEqual([]);
    expect(result.licenseClass).toBe("open");
  });

  it("never puts a malformed mbid on the wire — labs answers those with a 400", async () => {
    const result = await listenBrainzSimilarity.getSimilarArtists({
      mbid: "not-a-uuid",
      name: "Broken",
    });

    expect(result.data).toEqual([]);
    expect(stub.urls).toEqual([]);
    expect(stub.cacheKeys).toEqual([]);
  });

  it("survives a null payload for a well-formed mbid", async () => {
    stub.response = null;

    const result = await listenBrainzSimilarity.getSimilarArtists({
      mbid: DUSTER_MBID,
      name: "Duster",
    });

    expect(result.data).toEqual([]);
    expect(stub.urls).toHaveLength(1);
  });
});
