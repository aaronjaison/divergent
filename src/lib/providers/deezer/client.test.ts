import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cacheKeyFor,
  DeezerApiError,
  dzFetch,
  readDeezerError,
  secondsToMs,
  yearFromReleaseDate,
} from "./client";

// Bottleneck's real queue would make every test wait out the Deezer reservoir;
// the stub still routes through providerFetch, and exposes penalise so the
// HTTP-200 throttle path can be asserted.
const penalise = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/net/rateLimiter", () => ({
  limiterFor: () => ({ schedule: <T>(fn: () => Promise<T>) => fn() }),
  penalise,
}));

// The real cache is SQLite-backed; importing it would open the app database
// from a unit test. The stub runs the fetcher straight through so dzFetch's own
// error handling is still exercised.
vi.mock("@/lib/cache/cachedFetch", () => {
  const ttl = { fresh: 0, stale: 0 };
  return {
    TTL: {
      catalog: ttl,
      tags: ttl,
      similarity: ttl,
      popularity: ttl,
      search: ttl,
      permanent: ttl,
    },
    cachedFetch: <T>(_key: string, _provider: string, _ttl: unknown, fetcher: () => Promise<T>) =>
      fetcher(),
  };
});

/** GET /artist/999999999 — a real response, returned with HTTP 200. */
const NO_DATA_ERROR = {
  error: { type: "DataException", message: "no data", code: 800 },
};

/** GET /artist/399/toppp — also HTTP 200. */
const BAD_PATH_ERROR = {
  error: {
    type: "InvalidQueryException",
    message: "Unknown path components : /artist/399/toppp",
    code: 600,
  },
};

/** Quota exhaustion — HTTP 200 as well, so nothing upstream sees a 429. */
const QUOTA_ERROR = {
  error: { type: "Exception", message: "Quota limit exceeded", code: 4 },
};

const OK_PAYLOAD = { data: [{ id: 138547413, title: "You", duration: 208 }], total: 12 };

function stubJson(body: unknown): void {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  penalise.mockClear();
});

describe("readDeezerError", () => {
  it("recognises an error body served with HTTP 200", () => {
    expect(readDeezerError(NO_DATA_ERROR)).toEqual({
      type: "DataException",
      message: "no data",
      code: 800,
    });
  });

  it("returns null for a successful payload", () => {
    expect(readDeezerError(OK_PAYLOAD)).toBeNull();
    expect(readDeezerError({ data: [], total: 0 })).toBeNull();
    expect(readDeezerError(null)).toBeNull();
    expect(readDeezerError("error")).toBeNull();
  });
});

describe("dzFetch", () => {
  const ttl = { fresh: 0, stale: 0 };

  it("returns null for a 200 'no data' error body instead of leaking it as a payload", async () => {
    stubJson(NO_DATA_ERROR);
    await expect(dzFetch("/artist/999999999", {}, ttl)).resolves.toBeNull();
  });

  it("throws on non-data errors so a transient failure is never cached as empty", async () => {
    stubJson(BAD_PATH_ERROR);
    await expect(dzFetch("/artist/399/toppp", {}, ttl)).rejects.toBeInstanceOf(DeezerApiError);
  });

  it("backs the queue off when a quota error arrives as HTTP 200", async () => {
    stubJson(QUOTA_ERROR);
    await expect(dzFetch("/artist/399/top", { limit: 50 }, ttl)).rejects.toBeInstanceOf(
      DeezerApiError,
    );
    expect(penalise).toHaveBeenCalledWith("deezer", expect.any(Number));
  });

  it("does not back off for an error that says nothing about load", async () => {
    stubJson(BAD_PATH_ERROR);
    await expect(dzFetch("/artist/399/toppp", {}, ttl)).rejects.toBeInstanceOf(DeezerApiError);
    expect(penalise).not.toHaveBeenCalled();
  });

  it("passes a genuine payload through", async () => {
    stubJson(OK_PAYLOAD);
    await expect(dzFetch("/album/14880711/tracks", { limit: 100 }, ttl)).resolves.toEqual(
      OK_PAYLOAD,
    );
  });
});

describe("secondsToMs", () => {
  it("converts Deezer's whole seconds to milliseconds", () => {
    expect(secondsToMs(238)).toBe(238_000);
    expect(secondsToMs(2529)).toBe(2_529_000);
  });

  it("treats a missing or nonsensical duration as unknown", () => {
    expect(secondsToMs(0)).toBeUndefined();
    expect(secondsToMs(-5)).toBeUndefined();
    expect(secondsToMs(undefined)).toBeUndefined();
    expect(secondsToMs("238")).toBeUndefined();
    expect(secondsToMs(Number.NaN)).toBeUndefined();
  });
});

describe("yearFromReleaseDate", () => {
  it("takes the year from a YYYY-MM-DD string", () => {
    expect(yearFromReleaseDate("1993-02-22")).toBe(1993);
    expect(yearFromReleaseDate("2021-11-05")).toBe(2021);
  });

  it("rejects Deezer's unknown-date sentinel and junk", () => {
    expect(yearFromReleaseDate("0000-00-00")).toBeUndefined();
    expect(yearFromReleaseDate("")).toBeUndefined();
    expect(yearFromReleaseDate(undefined)).toBeUndefined();
    expect(yearFromReleaseDate("soon")).toBeUndefined();
  });
});

describe("cacheKeyFor", () => {
  it("is stable regardless of parameter order and query casing", () => {
    expect(cacheKeyFor("/search/artist", { q: "Radiohead", limit: 5 })).toBe(
      cacheKeyFor("/search/artist", { limit: 5, q: "radiohead" }),
    );
  });

  it("keeps distinct requests distinct", () => {
    expect(cacheKeyFor("/artist/399/top", { limit: 50 })).not.toBe(
      cacheKeyFor("/artist/399/top", { limit: 10 }),
    );
    expect(cacheKeyFor("/artist/399/top", { limit: 50 })).not.toBe(
      cacheKeyFor("/artist/399/albums", { limit: 50 }),
    );
  });
});
