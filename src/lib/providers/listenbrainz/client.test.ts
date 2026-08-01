import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMbid,
  labsCacheKey,
  labsFetch,
  labsTagLicense,
  normaliseScore,
  readNumber,
  readString,
  scoreDivisor,
} from "./client";

const stub = vi.hoisted(() => ({
  cacheKeys: [] as string[],
  urls: [] as string[],
  options: [] as (Record<string, unknown> | undefined)[],
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
  providerFetch: (
    _provider: string,
    url: string,
    options?: Record<string, unknown>,
  ) => {
    stub.urls.push(url);
    stub.options.push(options);
    return Promise.resolve(stub.response);
  },
}));

const TTL_STUB = { fresh: 1, stale: 2 };

beforeEach(() => {
  stub.cacheKeys.length = 0;
  stub.urls.length = 0;
  stub.options.length = 0;
  stub.response = null;
  stub.commercialLicense = false;
});

describe("labsCacheKey", () => {
  it("is stable under param reordering", () => {
    expect(labsCacheKey("similar-artists", { b: "2", a: "1" })).toBe(
      labsCacheKey("similar-artists", { a: "1", b: "2" }),
    );
  });

  it("separates endpoints and param values", () => {
    const keys = new Set([
      labsCacheKey("similar-artists", { artist_mbids: "x", algorithm: "one" }),
      labsCacheKey("similar-artists", { artist_mbids: "x", algorithm: "two" }),
      labsCacheKey("similar-artists", { artist_mbids: "y", algorithm: "one" }),
      labsCacheKey("similar-recordings", { artist_mbids: "x", algorithm: "one" }),
    ]);

    expect(keys.size).toBe(4);
  });

  it("drops empty params so they cannot alias a real value", () => {
    expect(labsCacheKey("tag-similarity", { tag: "rock", extra: undefined })).toBe(
      "lb_labs:tag-similarity:tag=rock",
    );
  });

  it("encodes values so free text cannot forge a second param", () => {
    // Without encoding both of these flatten to `...:a=1&b=2`.
    expect(
      labsCacheKey("tag-similarity", { tag: "a=1&b=2" }),
    ).not.toBe(labsCacheKey("tag-similarity", { a: "1", b: "2" }));
    expect(labsCacheKey("tag-similarity", { tag: "drum & bass" })).toBe(
      "lb_labs:tag-similarity:tag=drum%20%26%20bass",
    );
  });

  it("leaves mbids, tags and the algorithm token byte-identical", () => {
    // Encoding must not silently invalidate every existing cache row.
    expect(labsCacheKey("tag-similarity", { tag: "dream pop" })).toBe(
      "lb_labs:tag-similarity:tag=dream%20pop",
    );
    expect(
      labsCacheKey("spotify-id-from-mbid", {
        recording_mbid: "70595637-9310-45f2-a266-58f8de4874a7",
      }),
    ).toBe(
      "lb_labs:spotify-id-from-mbid:recording_mbid=70595637-9310-45f2-a266-58f8de4874a7",
    );
  });
});

describe("labsFetch", () => {
  it("lets a 400 surface instead of caching it as an empty result", async () => {
    stub.response = null;

    const result = await labsFetch("tag-similarity", { tag: "rock" }, TTL_STUB);

    // No emptyOn override: providerFetch's default is [404], so a 400 — which
    // can now only mean a renamed/missing param — throws rather than writing
    // `[]` into the cache for months.
    expect(stub.options[0]?.emptyOn).toBeUndefined();
    expect(result).toEqual([]);
  });

  it("degrades a non-array payload to an empty array", async () => {
    stub.response = { detail: "unexpected" };

    expect(await labsFetch("tag-similarity", { tag: "rock" }, TTL_STUB)).toEqual(
      [],
    );
  });

  it("passes an array payload through untouched", async () => {
    stub.response = [{ similar_tag: "dream pop", count: 3 }];

    expect(await labsFetch("tag-similarity", { tag: "rock" }, TTL_STUB)).toEqual([
      { similar_tag: "dream pop", count: 3 },
    ]);
  });
});

describe("score helpers", () => {
  it("divides by the largest score", () => {
    expect(scoreDivisor([825, 720, 161])).toBe(825);
  });

  it("falls back to 1 rather than dividing by zero", () => {
    expect(scoreDivisor([])).toBe(1);
    expect(scoreDivisor([0, 0, 0])).toBe(1);
    expect(scoreDivisor([-5, -9])).toBe(1);
  });

  it("clamps into 0-1", () => {
    expect(normaliseScore(161, 825)).toBeCloseTo(0.195, 3);
    expect(normaliseScore(825, 825)).toBe(1);
    expect(normaliseScore(0, 1)).toBe(0);
    expect(normaliseScore(-4, 1)).toBe(0);
    expect(normaliseScore(9, 1)).toBe(1);
  });
});

describe("field readers", () => {
  it("treats an empty or blank string as absent", () => {
    expect(readString("")).toBeUndefined();
    expect(readString("   ")).toBeUndefined();
    expect(readString(null)).toBeUndefined();
    expect(readString(7)).toBeUndefined();
    expect(readString(" US indie rock band ")).toBe("US indie rock band");
  });

  it("rejects non-finite and non-numeric scores", () => {
    expect(readNumber(0)).toBe(0);
    expect(readNumber(Number.NaN)).toBeUndefined();
    expect(readNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readNumber("825")).toBeUndefined();
    expect(readNumber(null)).toBeUndefined();
  });
});

describe("isMbid", () => {
  it("accepts a canonical lowercase uuid", () => {
    expect(isMbid("879d43c6-13a8-42f6-b8df-a9b7d50aa9e2")).toBe(true);
  });

  it("rejects everything labs answers with a 400", () => {
    expect(isMbid("")).toBe(false);
    expect(isMbid("not-a-uuid")).toBe(false);
    expect(isMbid("879d43c613a842f6b8dfa9b7d50aa9e2")).toBe(false);
    expect(isMbid("879d43c6-13a8-42f6-b8df-a9b7d50aa9e2 ")).toBe(false);
    expect(isMbid("879d43c6-13a8-42f6-b8df-a9b7d50aa9e2/x")).toBe(false);
    // Uppercase is a caller bug: every caller lowercases before the request,
    // and the cache key is built from that same lowercased value.
    expect(isMbid("879D43C6-13A8-42F6-B8DF-A9B7D50AA9E2")).toBe(false);
  });
});

describe("labsTagLicense", () => {
  it("is noncommercial by default — the tags correlated here are MusicBrainz's", () => {
    expect(labsTagLicense()).toBe("noncommercial");
  });

  it("becomes licensed once a MetaBrainz tier covers them", () => {
    stub.commercialLicense = true;

    expect(labsTagLicense()).toBe("licensed");
  });
});
