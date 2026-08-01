import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractTrackId, listenBrainzIds } from "./idResolution";

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

const CREEP_MBID = "70595637-9310-45f2-a266-58f8de4874a7";
const GLORY_BOX_MBID = "145f5c43-0ac2-4886-8b09-63d0e92ded5d";

/** Real /spotify-id-from-mbid hit. */
const SPOTIFY_CREEP = [
  {
    recording_mbid: CREEP_MBID,
    artist_name: "Radiohead",
    release_name: "Pablo Honey",
    track_name: "Creep",
    spotify_track_ids: ["70LcF31zb1H0PyJoS1Sx1r"],
  },
];

/** Real /apple-music-id-from-mbid hit — same envelope, different id key. */
const APPLE_CREEP = [
  {
    recording_mbid: CREEP_MBID,
    artist_name: "Radiohead",
    release_name: "Pablo Honey",
    track_name: "Creep",
    apple_music_track_ids: ["1097862231"],
  },
];

/** Real multi-id hit (8 ids live, first 3 kept) — per-market duplicates. */
const SPOTIFY_GLORY_BOX = [
  {
    recording_mbid: GLORY_BOX_MBID,
    artist_name: "Portishead",
    release_name: "Dummy",
    track_name: "Glory Box",
    spotify_track_ids: [
      "5AP1DPsMOViF7A2GqCls7W",
      "6OPgJ5qtIs0YHYN1hvCIRc",
      "149eIxUYu8xEkG81NIYH1x",
    ],
  },
];

beforeEach(() => {
  stub.cacheKeys.length = 0;
  stub.urls.length = 0;
  stub.response = null;
});

describe("extractTrackId", () => {
  it("reads the target's own id key", () => {
    expect(extractTrackId(SPOTIFY_CREEP, "spotify")).toBe(
      "70LcF31zb1H0PyJoS1Sx1r",
    );
    expect(extractTrackId(APPLE_CREEP, "apple")).toBe("1097862231");
  });

  it("does not cross-read the other platform's key", () => {
    expect(extractTrackId(SPOTIFY_CREEP, "apple")).toBeNull();
    expect(extractTrackId(APPLE_CREEP, "spotify")).toBeNull();
  });

  it("takes the first of several unranked ids", () => {
    expect(extractTrackId(SPOTIFY_GLORY_BOX, "spotify")).toBe(
      "5AP1DPsMOViF7A2GqCls7W",
    );
  });

  it("returns null for the empty-array miss", () => {
    expect(extractTrackId([], "spotify")).toBeNull();
    expect(extractTrackId([], "apple")).toBeNull();
  });

  it("returns null for a non-array or malformed payload", () => {
    expect(extractTrackId(null, "spotify")).toBeNull();
    expect(extractTrackId({ detail: "bad request" }, "spotify")).toBeNull();
    expect(extractTrackId([null, "row", 7], "spotify")).toBeNull();
    expect(
      extractTrackId([{ recording_mbid: CREEP_MBID }], "spotify"),
    ).toBeNull();
  });

  it("skips empty and non-string ids", () => {
    const rows = [
      { recording_mbid: CREEP_MBID, spotify_track_ids: [] },
      { recording_mbid: CREEP_MBID, spotify_track_ids: "70LcF31zb1H0PyJoS1" },
      { recording_mbid: CREEP_MBID, spotify_track_ids: [null, "", 12, "abc"] },
    ];

    expect(extractTrackId(rows, "spotify")).toBe("abc");
  });
});

describe("listenBrainzIds.idFromMbid", () => {
  it("resolves a spotify id and keys the cache per recording", async () => {
    stub.response = SPOTIFY_CREEP;

    const result = await listenBrainzIds.idFromMbid(
      CREEP_MBID.toUpperCase(),
      "spotify",
    );

    expect(result.data).toBe("70LcF31zb1H0PyJoS1Sx1r");
    expect(result.source).toBe("lb_labs");
    expect(result.licenseClass).toBe("open");
    expect(stub.urls[0]).toBe(
      `https://labs.api.listenbrainz.org/spotify-id-from-mbid/json?recording_mbid=${CREEP_MBID}`,
    );
    expect(stub.cacheKeys[0]).toBe(
      `lb_labs:spotify-id-from-mbid:recording_mbid=${CREEP_MBID}`,
    );
  });

  it("hits a different endpoint and cache key for apple", async () => {
    stub.response = APPLE_CREEP;

    const result = await listenBrainzIds.idFromMbid(CREEP_MBID, "apple");

    expect(result.data).toBe("1097862231");
    expect(stub.urls[0]).toContain("/apple-music-id-from-mbid/json?");
    expect(stub.cacheKeys[0]).toBe(
      `lb_labs:apple-music-id-from-mbid:recording_mbid=${CREEP_MBID}`,
    );
  });

  it("wraps the miss rather than returning a bare null", async () => {
    stub.response = [];

    const result = await listenBrainzIds.idFromMbid(CREEP_MBID, "spotify");

    expect(result.data).toBeNull();
    expect(result.source).toBe("lb_labs");
    expect(typeof result.fetchedAt).toBe("number");
  });

  it("returns null without calling out for a blank or malformed mbid", async () => {
    for (const bad of ["  ", "not-a-uuid", "70595637931045f2a26658f8de4874a7"]) {
      const result = await listenBrainzIds.idFromMbid(bad, "spotify");
      expect(result.data).toBeNull();
    }

    expect(stub.urls).toEqual([]);
    expect(stub.cacheKeys).toEqual([]);
  });
});
