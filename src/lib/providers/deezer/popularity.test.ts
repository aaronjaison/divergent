import { describe, expect, it, vi } from "vitest";
import {
  albumTrackRows,
  artistMatchScore,
  mapAlbums,
  mapArtistHit,
  mapTracks,
  pickAlbumMatch,
  pickArtistMatch,
} from "./popularity";

// See client.test.ts — keeps the SQLite-backed cache out of unit tests.
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

/**
 * GET /search/artist?q=Radiohead&limit=5 — real, trimmed. Note two artists are
 * literally named "Radiohead"; Deezer's relevance order is the only tie-break.
 */
const ARTIST_SEARCH = {
  data: [
    { id: 399, name: "Radiohead", nb_album: 45, nb_fan: 4067842, type: "artist" },
    { id: 323887691, name: "Radiohead", nb_album: 0, nb_fan: 472, type: "artist" },
    { id: 53477202, name: "DJ Radiohead", nb_album: 30, nb_fan: 63, type: "artist" },
    { id: 215702, name: "Robert Glasper", nb_album: 31, nb_fan: 43072, type: "artist" },
    { id: 7888234, name: "Kelly Lee Owens", nb_album: 41, nb_fan: 8397, type: "artist" },
  ],
  total: 11,
};

/** GET /artist/399/albums?limit=100 — real rows, one of each record_type. */
const ARTIST_ALBUMS = {
  data: [
    {
      id: 792320571,
      title: "Hail to the Thief (Live Recordings 2003-2009)",
      genre_id: 85,
      fans: 5952,
      release_date: "2025-08-13",
      record_type: "album",
      explicit_lyrics: true,
      type: "album",
    },
    {
      id: 265569082,
      title: "KID A MNESIA",
      genre_id: 85,
      fans: 29947,
      release_date: "2021-11-05",
      record_type: "album",
      explicit_lyrics: false,
      type: "album",
    },
    {
      id: 14880711,
      title: "Pablo Honey",
      genre_id: 85,
      fans: 90929,
      release_date: "1993-02-22",
      record_type: "album",
      explicit_lyrics: true,
      type: "album",
    },
    {
      id: 14880561,
      title: "In Rainbows (Disk 2)",
      genre_id: 85,
      fans: 28026,
      release_date: "2016-10-14",
      record_type: "ep",
      explicit_lyrics: true,
      type: "album",
    },
    {
      id: 264685862,
      title: "Follow Me Around",
      genre_id: 85,
      fans: 1163,
      release_date: "2021-11-01",
      record_type: "single",
      explicit_lyrics: false,
      type: "album",
    },
  ],
  total: 45,
};

/** GET /album/14880711/tracks — real, trimmed. Rows arrive in track_position order. */
const ALBUM_TRACKS = {
  data: [
    [138547413, "You", "GBAYE9200113", 208, 1, 533193],
    [138547415, "Creep", "GBAYE9200070", 238, 2, 978547],
    [138547417, "How Do You?", "GBAYE9300105", 132, 3, 432406],
    [138547419, "Stop Whispering", "GBAYE9300106", 325, 4, 422055],
    [138547421, "Thinking About You", "GBAYE9200114", 161, 5, 492594],
    [138547423, "Anyone Can Play Guitar", "GBAYE9300107", 217, 6, 447972],
    [138547425, "Ripcord", "GBAYE9300108", 189, 7, 399800],
    [138547427, "Vegetable", "GBAYE9300109", 192, 8, 399650],
    [138547429, "Prove Yourself", "GBAYE9200115", 145, 9, 369181],
    [138547431, "I Can't", "GBAYE9300110", 253, 10, 444846],
    [138547433, "Lurgee", "GBAYE9200116", 187, 11, 386337],
    [138547435, "Blow Out", "GBAYE9300111", 282, 12, 536310],
  ].map(([id, title, isrc, duration, position, rank]) => ({
    id,
    readable: true,
    title,
    title_short: title,
    title_version: "",
    isrc,
    duration,
    track_position: position,
    disk_number: 1,
    rank,
    explicit_lyrics: false,
    artist: { id: 399, name: "Radiohead", type: "artist" },
    type: "track",
  })),
  total: 12,
};

/** GET /artist/399/top?limit=50 — real first row. No isrc on this endpoint at all. */
const TOP_TRACKS = {
  data: [
    {
      id: 138547415,
      readable: true,
      title: "Creep",
      title_short: "Creep",
      title_version: "",
      duration: 238,
      rank: 978547,
      explicit_lyrics: true,
      contributors: [{ id: 399, name: "Radiohead", type: "artist", role: "Main" }],
      artist: { id: 399, name: "Radiohead", type: "artist" },
      album: { id: 14880711, title: "Pablo Honey", type: "album" },
      type: "track",
    },
  ],
  total: 100,
};

/** GET /artist/13/top — real row, for the case where a feature is credited. */
const TOP_TRACKS_FEATURED = {
  data: [
    {
      id: 916445,
      readable: true,
      title: "Till I Collapse",
      duration: 297,
      rank: 908564,
      explicit_lyrics: true,
      contributors: [
        { id: 13, name: "Eminem", type: "artist", role: "Main" },
        { id: 359, name: "Nate Dogg", type: "artist", role: "Featured" },
      ],
      artist: { id: 13, name: "Eminem", type: "artist" },
      album: { id: 103248, title: "The Eminem Show", type: "album" },
      type: "track",
    },
  ],
  total: 100,
};

describe("mapArtistHit", () => {
  it("reads id, name and nb_fan from a search hit", () => {
    expect(mapArtistHit(ARTIST_SEARCH.data[0])).toEqual({
      id: "399",
      name: "Radiohead",
      nbFan: 4067842,
      nbAlbum: 45,
    });
  });

  it("drops rows without a usable id or name", () => {
    expect(mapArtistHit({ id: 399 })).toBeNull();
    expect(mapArtistHit({ name: "Radiohead" })).toBeNull();
    expect(mapArtistHit(undefined)).toBeNull();
  });

  it("leaves nb_fan undefined when absent rather than defaulting to zero", () => {
    expect(mapArtistHit({ id: 399, name: "Radiohead" })?.nbFan).toBeUndefined();
  });
});

describe("artistMatchScore", () => {
  it("ignores casing, accents and a leading 'the'", () => {
    expect(artistMatchScore("radiohead", "Radiohead")).toBe(1);
    expect(artistMatchScore("Beatles", "The Beatles")).toBe(1);
    expect(artistMatchScore("Sigur Ros", "Sigur Rós")).toBe(1);
  });

  it("falls back to a raw comparison for names that normalise to nothing", () => {
    expect(artistMatchScore("坂本龍一", "坂本龍一")).toBe(1);
    expect(artistMatchScore("坂本龍一", "Radiohead")).toBe(0);
  });
});

describe("pickArtistMatch", () => {
  it("accepts an exact hit and prefers Deezer's relevance order on a tie", () => {
    // Two hits are both named "Radiohead" and both score 1.0.
    expect(pickArtistMatch(ARTIST_SEARCH, "Radiohead")?.id).toBe("399");
  });

  it("accepts a hit just above the 0.85 threshold", () => {
    // "radiohed" vs "radiohead" is one edit over nine characters: ~0.89.
    expect(pickArtistMatch(ARTIST_SEARCH, "Radiohed")?.id).toBe("399");
  });

  it("rejects the whole response when nothing clears the threshold", () => {
    expect(pickArtistMatch(ARTIST_SEARCH, "Portishead")).toBeNull();
    expect(pickArtistMatch(ARTIST_SEARCH, "Radio")).toBeNull();
    expect(pickArtistMatch(ARTIST_SEARCH, "Robert Glasper Experiment")).toBeNull();
  });

  it("handles an empty result set and an error body without throwing", () => {
    expect(pickArtistMatch({ data: [], total: 0 }, "Radiohead")).toBeNull();
    expect(
      pickArtistMatch({ error: { type: "DataException", message: "no data", code: 800 } }, "x"),
    ).toBeNull();
  });
});

describe("mapAlbums", () => {
  it("keeps only record_type 'album' when filtered", () => {
    const albums = mapAlbums(ARTIST_ALBUMS, ["album"]);
    expect(albums.map((a) => a.title)).toEqual([
      "Hail to the Thief (Live Recordings 2003-2009)",
      "KID A MNESIA",
      "Pablo Honey",
    ]);
    expect(albums.every((a) => a.primaryType === "Album")).toBe(true);
  });

  it("returns every record type when unfiltered, so an EP can still be resolved", () => {
    const all = mapAlbums(ARTIST_ALBUMS);
    expect(all).toHaveLength(5);
    expect(all.find((a) => a.title === "In Rainbows (Disk 2)")?.primaryType).toBe("EP");
    expect(all.find((a) => a.title === "Follow Me Around")?.primaryType).toBe("Single");
  });

  it("parses the year and carries the Deezer id", () => {
    const pabloHoney = mapAlbums(ARTIST_ALBUMS, ["album"]).find(
      (a) => a.title === "Pablo Honey",
    );
    expect(pabloHoney).toMatchObject({ externalId: "14880711", year: 1993 });
  });

  it("degrades rather than throwing on missing fields", () => {
    const albums = mapAlbums({
      data: [
        { id: 1, record_type: "album" },
        { id: 2, title: "No Date", record_type: "album" },
        "junk",
      ],
    });
    expect(albums).toEqual([
      { externalId: "2", title: "No Date", year: undefined, primaryType: "Album", secondaryTypes: undefined },
    ]);
  });
});

describe("pickAlbumMatch", () => {
  const albums = mapAlbums(ARTIST_ALBUMS);

  it("matches through casing and reissue noise", () => {
    expect(pickAlbumMatch(albums, "Pablo Honey (Deluxe Edition)")?.externalId).toBe("14880711");
    expect(pickAlbumMatch(albums, "Kid A Mnesia")?.externalId).toBe("265569082");
  });

  it("returns null when no title is close enough", () => {
    expect(pickAlbumMatch(albums, "OK Computer")).toBeNull();
    // An unrecognised edition suffix is far enough off to be rejected rather
    // than guessed at — a wrong album silently poisons a whole deep-cut pool.
    expect(pickAlbumMatch(albums, "Pablo Honey (Collectors Edition)")).toBeNull();
    expect(pickAlbumMatch([], "Pablo Honey")).toBeNull();
  });
});

describe("mapTracks", () => {
  it("carries per-track rank across a whole album payload", () => {
    const tracks = mapTracks(ALBUM_TRACKS, { album: "Pablo Honey", year: 1993 });
    expect(tracks).toHaveLength(12);
    expect(tracks.map((t) => t.rank)).toEqual([
      533193, 978547, 432406, 422055, 492594, 447972, 399800, 399650, 369181, 444846, 386337,
      536310,
    ]);
    // The hit outranking the album floor by 2.6x is the deep-cut signal.
    expect(Math.max(...tracks.map((t) => t.rank ?? 0))).toBe(978547);
  });

  it("converts seconds to milliseconds and normalises the ISRC", () => {
    const creep = mapTracks(ALBUM_TRACKS, { album: "Pablo Honey" })[1];
    expect(creep).toMatchObject({
      externalId: "138547415",
      title: "Creep",
      album: "Pablo Honey",
      isrc: "GBAYE9200070",
      durationMs: 238_000,
    });
  });

  it("prefers contributors over the single artist object for multi-artist tracks", () => {
    const [collab] = mapTracks(TOP_TRACKS_FEATURED, { artistNames: ["Eminem"] });
    expect(collab.artistNames).toEqual(["Eminem", "Nate Dogg"]);
  });

  it("reads the embedded album title and finds no ISRC on the top-tracks endpoint", () => {
    const [creep] = mapTracks(TOP_TRACKS);
    expect(creep.isrc).toBeUndefined();
    expect(creep.album).toBe("Pablo Honey");
    expect(creep.rank).toBe(978547);
  });

  it("falls back to the requesting artist when a row names nobody", () => {
    const [track] = mapTracks(
      { data: [{ id: 1, title: "Untitled", duration: 100 }] },
      { artistNames: ["Radiohead"] },
    );
    expect(track.artistNames).toEqual(["Radiohead"]);
  });
});

describe("albumTrackRows", () => {
  it("reads both the /album/{id}/tracks envelope and the embedded tracks object", () => {
    expect(albumTrackRows(ALBUM_TRACKS)).toHaveLength(12);
    expect(albumTrackRows({ id: 14880711, tracks: { data: ALBUM_TRACKS.data } })).toHaveLength(
      12,
    );
  });

  it("returns nothing for an error body or a malformed payload", () => {
    expect(albumTrackRows({ error: { type: "DataException", code: 800 } })).toEqual([]);
    expect(albumTrackRows(null)).toEqual([]);
  });
});
