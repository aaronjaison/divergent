import { describe, expect, it, vi } from "vitest";
import {
  collapseRecordings,
  mapArtistSearchResult,
  mapReleaseGroup,
  mapReleaseGroupSearchHit,
  mapReleaseTracks,
  mergeTags,
  parseYear,
  pickBestRelease,
  queryFit,
} from "./catalog";

// The helpers under test are pure, but they sit in a module that transitively
// imports the cache — stub the driver so a unit test never opens SQLite.
vi.mock("@/lib/db/client", () => ({ db: {}, schema: {} }));

/**
 * Fixtures are trimmed captures from live WS/2 responses (2026-08-01). Key
 * order is preserved as returned, because MB genuinely varies it between
 * objects of the same type in one response.
 */

// /ws/2/artist?query=radiohead&limit=5
const ARTIST_SEARCH = {
  created: "2026-08-01T22:01:21.410Z",
  count: 29,
  offset: 0,
  artists: [
    {
      id: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      type: "Group",
      score: 100,
      name: "Radiohead",
      "sort-name": "Radiohead",
      country: "GB",
      area: {
        id: "8a754a16-0027-3a29-b6d7-2b40ea0481ed",
        type: "Country",
        name: "United Kingdom",
        "life-span": { ended: null },
      },
      "life-span": { begin: "1991", ended: null },
      tags: [
        { count: 18, name: "rock" },
        { count: 0, name: "post-rock" },
        { count: 42, name: "alternative rock" },
        { count: 14, name: "british" },
        { count: -1, name: "england" },
        { count: -1, name: "sacred cows" },
      ],
    },
    {
      id: "c74f4726-2671-4011-81b6-f70da905c05a",
      type: "Group",
      score: 63,
      name: "On a Friday",
      "sort-name": "On a Friday",
      disambiguation: "pre‐Radiohead group, until 1991",
      "life-span": { begin: "1985", end: "1991", ended: true },
      tags: [{ count: 1, name: "indie pop" }],
    },
    {
      id: "3ecaa799-94ae-45cd-9ad1-bcabae4073e1",
      score: 62,
      name: "radiohead 3",
      "sort-name": "radiohead 3",
      disambiguation: "Capsmusic LTD. artist",
      "life-span": { ended: null },
    },
  ],
} as const;

// /ws/2/artist/{mbid}?inc=genres+tags — trimmed to the entries the tests use.
const ARTIST_LOOKUP = {
  area: {
    type: null,
    "iso-3166-1-codes": ["GB"],
    disambiguation: "",
    name: "United Kingdom",
    id: "8a754a16-0027-3a29-b6d7-2b40ea0481ed",
  },
  "life-span": { ended: false, end: null, begin: "1991" },
  tags: [
    { count: 2, name: "alternative" },
    { count: 42, name: "alternative rock" },
    { name: "art rock", count: 29 },
    { name: "british", count: 14 },
    { name: "experimental rock", count: 14 },
    { count: 1, name: "oxford" },
    { name: "rock", count: 18 },
    { count: 1, name: "vyrzukhisuc-artiest" },
  ],
  type: "Group",
  country: "GB",
  name: "Radiohead",
  disambiguation: "",
  "sort-name": "Radiohead",
  genres: [
    {
      name: "alternative rock",
      disambiguation: "",
      id: "ceeaa283-5d7b-4202-8d1d-e25d116b2a18",
      count: 42,
    },
    {
      disambiguation: "",
      name: "art rock",
      id: "b7ef058e-6d83-4ca4-8123-9724bff4648b",
      count: 29,
    },
    {
      count: 14,
      id: "65c97e89-b42b-45c2-a70e-0eca1b8f0ff7",
      name: "experimental rock",
      disambiguation: "",
    },
    {
      count: 18,
      id: "0e3fc579-2d24-4f20-9dae-736e1ec78798",
      name: "rock",
      disambiguation: "",
    },
  ],
  id: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  gender: null,
  "end-area": null,
} as const;

// /ws/2/release-group?artist={mbid}&type=album&limit=100
const RELEASE_GROUPS = [
  {
    "primary-type-id": "f529b476-6e62-324f-b0aa-1f3e33d313fc",
    id: "01618034-2de5-4ace-a057-fcd0bca4cf08",
    "primary-type": "Album",
    "secondary-type-ids": ["6fd474e2-6b58-3102-9d17-d6f7eb7da0a0"],
    "first-release-date": "1995-06-10",
    "secondary-types": ["Live"],
    title: "1995‐06‐10: Cabaret Metro, Chicago, IL, USA",
    disambiguation: "",
  },
  {
    title: "Fond, but Not in Love: The B Sides",
    disambiguation: "",
    id: "0711af11-e061-3ec9-a2a8-8c85738be984",
    "primary-type": "Album",
    "secondary-types": ["Compilation"],
    "first-release-date": "",
  },
  {
    title: "Greenhouse Effect vs. Radiohead",
    disambiguation: "",
    id: "11f16b31-da2e-48b8-90a1-f65014bc8262",
    "primary-type": "Album",
    "first-release-date": "2005-08",
    "secondary-types": ["Remix"],
  },
  {
    title: "OK Computer",
    disambiguation: "",
    id: "b1392450-e666-3926-a536-22c65f834433",
    "primary-type": "Album",
    "secondary-types": [],
    "secondary-type-ids": [],
    "first-release-date": "1997-05-21",
  },
] as const;

// /ws/2/release?release-group=…&inc=recordings+artist-credits+isrcs&status=official
const OK_COMPUTER_JP = {
  id: "1834eae1-741b-3c03-9ca5-0df3decb43ea",
  title: "OK Computer",
  status: "Official",
  date: "1997-05-21",
  country: "JP",
  disambiguation: "",
  packaging: null,
  asin: "B00002MMMG",
  "artist-credit": [
    {
      name: "Radiohead",
      joinphrase: "",
      artist: {
        id: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        name: "Radiohead",
        "sort-name": "Radiohead",
      },
    },
  ],
  media: [
    {
      position: 1,
      format: "CD",
      title: "",
      "track-count": 12,
      "track-offset": 0,
      tracks: [
        {
          id: "ff7733a6-6903-3e2e-b683-6dbbb0f59ec6",
          position: 1,
          number: "1",
          title: "Airbag",
          length: 284400,
          "artist-credit": [
            { name: "Radiohead", joinphrase: "", artist: { id: "a74b1b7f-71a5-4011-9441-d0b5e4122711", name: "Radiohead" } },
          ],
          recording: {
            id: "4a7fea2e-545b-4c63-bc9a-9943cc3a29d7",
            title: "Airbag",
            length: 284400,
            "first-release-date": "1997-05-21",
            video: false,
            disambiguation: "",
            isrcs: ["GBAYE9701274", "GBBKS1700107"],
          },
        },
        {
          id: "6a7cd9af-f665-3652-9aba-1e89a4236e9f",
          position: 2,
          number: "2",
          title: "Paranoid Android",
          length: 383493,
          "artist-credit": [
            { name: "Radiohead", joinphrase: "", artist: { id: "a74b1b7f-71a5-4011-9441-d0b5e4122711", name: "Radiohead" } },
          ],
          recording: {
            id: "9f9cf187-d6f9-437f-9d98-d59cdbd52757",
            title: "Paranoid Android",
            length: 384000,
            "first-release-date": "1997-05-21",
            video: false,
            disambiguation: "",
            isrcs: ["GBAYE9701376", "GBBKS1700108"],
          },
        },
      ],
    },
  ],
} as const;

const OK_COMPUTER_XE = {
  id: "425d8db9-88a3-31e2-bd23-b1a967626dd5",
  title: "OK Computer",
  status: "Official",
  date: "1997-06-16",
  country: "XE",
  media: [
    {
      position: 1,
      format: "CD",
      "track-count": 12,
      "track-offset": 0,
      tracks: [
        {
          id: "86863720-40fc-3cff-b33b-b308122b3b41",
          position: 1,
          number: "1",
          title: "Airbag",
          length: 284400,
          recording: {
            id: "4a7fea2e-545b-4c63-bc9a-9943cc3a29d7",
            title: "Airbag",
            length: 284400,
            "first-release-date": "1997-05-21",
            isrcs: ["GBAYE9701274", "GBBKS1700107"],
          },
        },
      ],
    },
  ],
} as const;

// The only release of a live release-group: bootleg, and every ISRC list empty.
const BOOTLEG_LIVE = {
  id: "6c3e0ef1-8f38-4ea6-8017-e96d09fdb34c",
  title: "1995‐06‐10: Cabaret Metro, Chicago, IL, USA",
  status: "Bootleg",
  date: "1995-06-10",
  country: "US",
  media: [
    {
      position: 1,
      format: "Digital Media",
      "track-count": 18,
      "track-offset": 0,
      tracks: [
        {
          id: "c18d983c-7abf-4d3b-a398-675f256f37be",
          position: 1,
          number: "1",
          title: "The Bends",
          length: 238000,
          "artist-credit": [
            { joinphrase: "", name: "Radiohead", artist: { id: "a74b1b7f-71a5-4011-9441-d0b5e4122711", name: "Radiohead" } },
          ],
          recording: {
            id: "553338ad-9e76-4881-9d9e-e4474cde2189",
            title: "The Bends",
            length: 238000,
            "first-release-date": "1995-06-10",
            isrcs: [],
          },
        },
      ],
    },
  ],
} as const;

/** Real credit pair from a /ws/2/recording search for "Under Pressure". */
const BOWIE_QUEEN_CREDIT = [
  {
    name: "David Bowie",
    joinphrase: " & ",
    artist: { id: "5441c29d-3602-4898-b1a1-b77fa23b8e50", name: "David Bowie" },
  },
  {
    name: "Queen",
    artist: { id: "0383dadf-2a8e-4d10-a46a-e9e041da8eb3", name: "Queen" },
  },
] as const;

function must<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}

describe("parseYear", () => {
  it("reads a year out of every partial-date length MB emits", () => {
    expect(parseYear("1997-05-21")).toBe(1997);
    expect(parseYear("2005-08")).toBe(2005);
    expect(parseYear("1985")).toBe(1985);
  });

  it("treats an unknown date as absent rather than as year zero", () => {
    // "" is what release-groups actually return for an unknown date.
    expect(parseYear("")).toBeUndefined();
    expect(parseYear(null)).toBeUndefined();
    expect(parseYear(undefined)).toBeUndefined();
    expect(parseYear("unknown")).toBeUndefined();
  });
});

describe("mapArtistSearchResult", () => {
  it("normalises the 0-100 relevance score to 0-1", () => {
    const [top, second] = ARTIST_SEARCH.artists.map((raw) => must(mapArtistSearchResult(raw)));
    expect(top.score).toBe(1);
    expect(second.score).toBeCloseTo(0.63, 5);
  });

  it("keeps the fields the picker UI disambiguates on", () => {
    const top = must(mapArtistSearchResult(ARTIST_SEARCH.artists[0]));
    expect(top).toMatchObject({
      mbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      name: "Radiohead",
      country: "GB",
      beginYear: 1991,
    });
    expect(top.endYear).toBeUndefined();
    expect(top.disambiguation).toBeUndefined();
  });

  it("parses a closed life-span, and a year-only begin", () => {
    const onAFriday = must(mapArtistSearchResult(ARTIST_SEARCH.artists[1]));
    expect(onAFriday.beginYear).toBe(1985);
    expect(onAFriday.endYear).toBe(1991);
    expect(onAFriday.disambiguation).toBe("pre‐Radiohead group, until 1991");
    // Only the top hit had a country in this response.
    expect(onAFriday.country).toBeUndefined();
  });

  it("survives a result carrying nothing but ended: null", () => {
    const sparse = must(mapArtistSearchResult(ARTIST_SEARCH.artists[2]));
    expect(sparse.beginYear).toBeUndefined();
    expect(sparse.endYear).toBeUndefined();
    expect(sparse.country).toBeUndefined();
  });

  it("falls back to the area's ISO code when country is missing", () => {
    const { country: _dropped, ...withoutCountry } = ARTIST_LOOKUP;
    expect(must(mapArtistSearchResult(withoutCountry)).country).toBe("GB");
  });

  it("scores a lookup response, which has no score at all, as zero", () => {
    expect(must(mapArtistSearchResult(ARTIST_LOOKUP)).score).toBe(0);
  });

  it("reads an empty disambiguation as absent", () => {
    expect(must(mapArtistSearchResult(ARTIST_LOOKUP)).disambiguation).toBeUndefined();
  });

  it("returns null instead of throwing on anything unusable", () => {
    expect(mapArtistSearchResult(null)).toBeNull();
    expect(mapArtistSearchResult({})).toBeNull();
    expect(mapArtistSearchResult({ id: 7, name: "x" })).toBeNull();
    expect(mapArtistSearchResult("Radiohead")).toBeNull();
  });
});

describe("mergeTags", () => {
  it("normalises the strongest tag to 1", () => {
    const merged = mergeTags(ARTIST_LOOKUP.genres, ARTIST_LOOKUP.tags);
    expect(merged["alternative rock"]).toBe(1);
    expect(merged["art rock"]).toBeCloseTo(29 / 42, 5);
  });

  it("ranks a curated genre above a raw tag with the identical vote count", () => {
    // Both sit at 14 votes; only "experimental rock" is in the genre vocabulary.
    const merged = mergeTags(ARTIST_LOOKUP.genres, ARTIST_LOOKUP.tags);
    expect(merged["experimental rock"]).toBeCloseTo(14 / 42, 5);
    expect(merged["british"]).toBeCloseTo((14 * 0.6) / 42, 5);
    expect(merged["experimental rock"]).toBeGreaterThan(merged["british"]);
  });

  it("keeps every weight inside 0-1", () => {
    for (const weight of Object.values(mergeTags(ARTIST_LOOKUP.genres, ARTIST_LOOKUP.tags))) {
      expect(weight).toBeGreaterThan(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });

  it("drops the zero and negative counts search results carry", () => {
    const merged = mergeTags(undefined, ARTIST_SEARCH.artists[0].tags);
    expect(merged["post-rock"]).toBeUndefined();
    expect(merged["england"]).toBeUndefined();
    expect(merged["sacred cows"]).toBeUndefined();
    // Still normalised against the surviving maximum.
    expect(merged["alternative rock"]).toBe(1);
  });

  it("works from tags alone, since search results never include genres", () => {
    const merged = mergeTags(undefined, ARTIST_SEARCH.artists[1].tags);
    expect(merged).toEqual({ "indie pop": 1 });
  });

  it("returns an empty map rather than dividing by zero", () => {
    expect(mergeTags(undefined, undefined)).toEqual({});
    expect(mergeTags([], [])).toEqual({});
    expect(mergeTags(null, [{ name: "england", count: -1 }])).toEqual({});
  });
});

describe("mapReleaseGroup", () => {
  it("captures the secondary types the engine excludes on", () => {
    expect(must(mapReleaseGroup(RELEASE_GROUPS[0])).secondaryTypes).toEqual(["Live"]);
    expect(must(mapReleaseGroup(RELEASE_GROUPS[1])).secondaryTypes).toEqual(["Compilation"]);
    expect(must(mapReleaseGroup(RELEASE_GROUPS[2])).secondaryTypes).toEqual(["Remix"]);
  });

  it("gives a studio album an empty secondary-type list either way", () => {
    // MB has returned both [] and no key at all for the same situation.
    expect(must(mapReleaseGroup(RELEASE_GROUPS[3])).secondaryTypes).toEqual([]);
    const { "secondary-types": _dropped, ...noKey } = RELEASE_GROUPS[3];
    expect(must(mapReleaseGroup(noKey)).secondaryTypes).toEqual([]);
  });

  it("maps the release group's identity and year", () => {
    expect(must(mapReleaseGroup(RELEASE_GROUPS[3]))).toMatchObject({
      mbid: "b1392450-e666-3926-a536-22c65f834433",
      title: "OK Computer",
      year: 1997,
      primaryType: "Album",
    });
    expect(must(mapReleaseGroup(RELEASE_GROUPS[2])).year).toBe(2005);
  });

  it("leaves the year undefined when the date is the empty string", () => {
    expect(must(mapReleaseGroup(RELEASE_GROUPS[1])).year).toBeUndefined();
  });

  it("returns null for an unusable entry", () => {
    expect(mapReleaseGroup({ title: "no id" })).toBeNull();
    expect(mapReleaseGroup(undefined)).toBeNull();
  });
});

describe("pickBestRelease", () => {
  it("takes the earliest pressing rather than whatever came back first", () => {
    expect(must(pickBestRelease([OK_COMPUTER_XE, OK_COMPUTER_JP])).id).toBe(
      OK_COMPUTER_JP.id,
    );
  });

  it("prefers an official release over an earlier bootleg", () => {
    expect(must(pickBestRelease([BOOTLEG_LIVE, OK_COMPUTER_JP])).id).toBe(
      OK_COMPUTER_JP.id,
    );
  });

  it("still returns a bootleg when that is the only pressing that exists", () => {
    expect(must(pickBestRelease([BOOTLEG_LIVE])).id).toBe(BOOTLEG_LIVE.id);
  });

  it("ignores releases with no tracklist, and empty input", () => {
    const trackless = { ...OK_COMPUTER_JP, id: "trackless", media: [] };
    expect(must(pickBestRelease([trackless, OK_COMPUTER_XE])).id).toBe(OK_COMPUTER_XE.id);
    expect(pickBestRelease([trackless])).toBeNull();
    expect(pickBestRelease([])).toBeNull();
    expect(pickBestRelease(undefined)).toBeNull();
  });
});

describe("mapReleaseTracks", () => {
  const album = {
    mbid: "b1392450-e666-3926-a536-22c65f834433",
    title: "OK Computer",
    year: 1997,
  };

  it("orders by track position, not by response order", () => {
    const shuffled = {
      ...OK_COMPUTER_JP,
      media: [
        { ...OK_COMPUTER_JP.media[0], tracks: [...OK_COMPUTER_JP.media[0].tracks].reverse() },
      ],
    };
    const tracks = mapReleaseTracks(must(pickBestRelease([shuffled])), album);
    expect(tracks.map((track) => track.title)).toEqual(["Airbag", "Paranoid Android"]);
  });

  it("carries identity, credits, ISRC and year through", () => {
    const [airbag] = mapReleaseTracks(must(pickBestRelease([OK_COMPUTER_JP])), album);
    expect(airbag).toEqual({
      mbid: "4a7fea2e-545b-4c63-bc9a-9943cc3a29d7",
      title: "Airbag",
      artistNames: ["Radiohead"],
      album: "OK Computer",
      albumMbid: "b1392450-e666-3926-a536-22c65f834433",
      isrc: "GBAYE9701274",
      durationMs: 284400,
      year: 1997,
    });
  });

  it("prefers this pressing's duration over the recording's", () => {
    // Paranoid Android: 383493 on the track, 384000 on the recording.
    const tracks = mapReleaseTracks(must(pickBestRelease([OK_COMPUTER_JP])), album);
    expect(tracks[1].durationMs).toBe(383493);
  });

  it("leaves the ISRC undefined when the recording has none", () => {
    const [track] = mapReleaseTracks(must(pickBestRelease([BOOTLEG_LIVE])));
    expect(track.isrc).toBeUndefined();
    expect(track.album).toBe(BOOTLEG_LIVE.title);
    expect(track.albumMbid).toBeUndefined();
  });

  it("keeps every credited artist, in credit order", () => {
    const collaboration = {
      id: "collab",
      title: "Hot Space",
      media: [
        {
          position: 1,
          tracks: [{ position: 1, title: "Under Pressure", "artist-credit": BOWIE_QUEEN_CREDIT }],
        },
      ],
    };
    const [track] = mapReleaseTracks(must(pickBestRelease([collaboration])));
    expect(track.artistNames).toEqual(["David Bowie", "Queen"]);
  });

  it("degrades a track stripped of every optional field", () => {
    const bare = {
      id: "bare",
      title: "Untitled",
      media: [{ tracks: [{ title: "Track One" }] }],
    };
    const [track] = mapReleaseTracks(must(pickBestRelease([bare])));
    expect(track).toEqual({
      mbid: undefined,
      title: "Track One",
      artistNames: [],
      album: "Untitled",
      albumMbid: undefined,
      isrc: undefined,
      durationMs: undefined,
      year: undefined,
    });
  });

  it("falls back to the release credit when the track carries none", () => {
    const withoutTrackCredits = {
      ...OK_COMPUTER_JP,
      media: [{ position: 1, tracks: [{ position: 1, title: "Airbag" }] }],
    };
    const [track] = mapReleaseTracks(must(pickBestRelease([withoutTrackCredits])));
    expect(track.artistNames).toEqual(["Radiohead"]);
  });

  it("returns nothing for a release with no media at all", () => {
    expect(mapReleaseTracks({ id: "x", title: "x" })).toEqual([]);
    expect(mapReleaseTracks({ id: "x", title: "x", media: null })).toEqual([]);
  });
});

describe("queryFit", () => {
  it("prefers the arrangement the listener actually typed", () => {
    // MusicBrainz scores these the other way round: an album called Radiohead
    // by a band called In Rainbows takes 100 and the record itself takes 82,
    // because both match every word across the two fields.
    const query = "in rainbows radiohead";
    expect(queryFit(query, "In Rainbows", ["Radiohead"])).toBeGreaterThan(
      queryFit(query, "Radiohead", ["In Rainbows"]),
    );
  });

  it("prefers the hit that accounts for more of the query", () => {
    const query = "black hole sun";
    // A band called Black Hole takes the top three places on relevance alone.
    expect(queryFit(query, "Black Hole Sun", ["Soundgarden"])).toBeGreaterThan(
      queryFit(query, "Black Hole", ["Black Hole"]),
    );
  });

  it("credits a word to the title first, so a self-titled act cannot claim it twice", () => {
    expect(queryFit("black hole", "Black Hole", ["Black Hole"])).toBe(
      queryFit("black hole", "Black Hole", ["Someone Else"]),
    );
  });

  it("penalises a title carrying words nobody asked for", () => {
    const query = "in rainbows radiohead";
    expect(queryFit(query, "In Rainbows", ["Radiohead"])).toBeGreaterThan(
      queryFit(query, "In Rainbows Disk 2", ["Radiohead"]),
    );
  });

  it("scores an exact song-then-artist query at the maximum", () => {
    expect(queryFit("karma police radiohead", "Karma Police", ["Radiohead"])).toBe(1);
  });

  it("ignores case, accents and punctuation", () => {
    expect(queryFit("cafe bleu the style council", "Café Bleu", ["The Style Council"])).toBe(1);
  });

  it("returns 0 for an empty query rather than dividing by zero", () => {
    expect(queryFit("", "Anything", ["Anyone"])).toBe(0);
    expect(queryFit("   ", "Anything", ["Anyone"])).toBe(0);
  });

  it("handles a hit with no artist credit at all", () => {
    expect(Number.isNaN(queryFit("something", "Something", []))).toBe(false);
  });
});

describe("collapseRecordings", () => {
  const recording = (
    id: string,
    title: string,
    artist: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    title,
    score: 97,
    "artist-credit": [{ name: artist }],
    ...extra,
  });

  it("folds every pressing of one song into a single row", () => {
    const rows = collapseRecordings(
      [
        recording("11111111-1111-1111-1111-111111111111", "Karma Police", "Radiohead"),
        recording("22222222-2222-2222-2222-222222222222", "Karma Police", "Radiohead"),
        recording("33333333-3333-3333-3333-333333333333", "Karma Police", "Radiohead"),
      ],
      10,
      "karma police radiohead",
    );

    expect(rows).toHaveLength(1);
    // Every candidate id survives: which one the similarity index knows about
    // cannot be determined from here.
    expect(rows[0].mbids).toHaveLength(3);
  });

  it("puts the original above its covers even when only the covers carry an ISRC", () => {
    /**
     * The measurement this scoring exists for. Asked for "running up that
     * hill", MusicBrainz returns Kate Bush's original eight times over with no
     * ISRC on any of them — nobody filed one in 1985 — while every cover is a
     * modern digital release that has one. Ranking on ISRC put Club for Five,
     * Kidz Bop and eight others above her.
     */
    const kateBush = Array.from({ length: 8 }, (_, i) =>
      recording(`aaaaaaaa-aaaa-aaaa-aaaa-00000000000${i}`, "Running Up That Hill", "Kate Bush", {
        length: 300_000,
      }),
    );
    const cover = recording(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "Running Up That Hill",
      "Kidz Bop",
      { length: 216_888, isrcs: ["USAB02202167"], releases: [{ id: "r1" }, { id: "r2" }] },
    );

    const rows = collapseRecordings([cover, ...kateBush], 10, "running up that hill");
    expect(rows[0].artistNames).toEqual(["Kate Bush"]);
  });

  it("still trusts the ISRC-bearing id WITHIN a song", () => {
    // Between songs an ISRC means a distributor filed one. Within one song it
    // means this is the id the listening data is likely to know.
    const stub = recording("cccccccc-cccc-cccc-cccc-cccccccccccc", "RICKY", "Denzel Curry");
    const real = recording("dddddddd-dddd-dddd-dddd-dddddddddddd", "RICKY", "Denzel Curry", {
      length: 190_000,
      isrcs: ["USUM71900001"],
      releases: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
    });

    const [row] = collapseRecordings([stub, real], 10, "ricky denzel curry");
    expect(row.mbids[0]).toBe("dddddddd-dddd-dddd-dddd-dddddddddddd");
  });

  it("drops music videos, which are not songs", () => {
    const rows = collapseRecordings(
      [
        recording("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "Creep", "Radiohead", {
          video: true,
        }),
      ],
      10,
      "creep radiohead",
    );
    expect(rows).toEqual([]);
  });

  it("keeps two different songs that share a title apart", () => {
    const rows = collapseRecordings(
      [
        recording("ffffffff-ffff-ffff-ffff-ffffffffffff", "Alison", "Elvis Costello"),
        recording("99999999-9999-9999-9999-999999999999", "Alison", "Slowdive"),
      ],
      10,
      "alison slowdive",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].artistNames).toEqual(["Slowdive"]);
  });

  it("survives junk rows without an id or a title", () => {
    const rows = collapseRecordings(
      [{ id: null, title: "No id" }, { id: "x", title: null }, null, "nonsense"],
      10,
      "anything",
    );
    expect(rows).toEqual([]);
  });
});

describe("mapReleaseGroupSearchHit ranking", () => {
  const album = (
    title: string,
    artist: string,
    score: number,
    tags: { name: string; count: number }[],
    primaryType = "Album",
  ) => ({
    id: `${title}-${artist}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    score,
    "primary-type": primaryType,
    "artist-credit": [{ name: artist }],
    tags,
  });

  const scoreOf = (raw: unknown, query: string) =>
    mapReleaseGroupSearchHit(raw, query)?.score ?? 0;

  it("ranks a landmark record above an unrelated one that matched as a phrase", () => {
    /**
     * The measurement behind tagVotes. dismaxQuery boosts an exact-phrase title
     * match to get short titles into the page at all, which hands "Nowhere Ride
     * E.P." a normalised 100 and leaves Ride's Nowhere on 24. On tag COUNT the
     * EP also wins — three tags to two that have any votes — and only the vote
     * totals, 5 against 3, put the right record first.
     */
    const query = "nowhere ride";
    const nowhere = album("Nowhere", "Ride", 24, [
      { name: "rock", count: 2 },
      { name: "shoegaze", count: 3 },
      { name: "shoegazing", count: 0 },
      { name: "indie", count: 0 },
      { name: "noise pop", count: 0 },
      { name: "shoegazer", count: 0 },
    ]);
    const phraseMatch = album(
      "Nowhere Ride E.P.",
      "The Chelsea Smiles",
      100,
      [
        { name: "rock", count: 1 },
        { name: "punk", count: 1 },
        { name: "garage rock", count: 1 },
      ],
      "EP",
    );

    expect(scoreOf(nowhere, query)).toBeGreaterThan(scoreOf(phraseMatch, query));
  });

  it("does not count a curated genre twice", () => {
    // MusicBrainz returns `genres` as a subset of `tags` with identical counts.
    const withBoth = {
      ...album("Kid A", "Radiohead", 100, [{ name: "electronic", count: 6 }]),
      genres: [{ name: "electronic", count: 6 }],
    };
    const tagsOnly = album("Kid A", "Radiohead", 100, [
      { name: "electronic", count: 6 },
    ]);

    expect(scoreOf(withBoth, "kid a")).toBe(scoreOf(tagsOnly, "kid a"));
  });

  it("ignores negative vote counts rather than subtracting them", () => {
    const downvoted = album("Nowhere", "Ride", 24, [
      { name: "shoegaze", count: 5 },
      { name: "sacred cows", count: -3 },
    ]);
    const clean = album("Nowhere", "Ride", 24, [{ name: "shoegaze", count: 5 }]);

    expect(scoreOf(downvoted, "nowhere ride")).toBe(scoreOf(clean, "nowhere ride"));
  });

  it("returns null for something that is not a release group at all", () => {
    expect(mapReleaseGroupSearchHit("nonsense", "x")).toBeNull();
    expect(mapReleaseGroupSearchHit(null, "x")).toBeNull();
  });
});
