import { describe, expect, it, vi } from "vitest";
import { mapSimilarArtists } from "./similarity";

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

/** GET /artist/399/related?limit=20 — real, trimmed to the first five rows. */
const RELATED = {
  data: [
    { id: 664, name: "Jeff Buckley", nb_album: 21, nb_fan: 322417, type: "artist" },
    { id: 193331, name: "The Smashing Pumpkins", nb_album: 33, nb_fan: 1760977, type: "artist" },
    { id: 743, name: "Blur", nb_album: 39, nb_fan: 1496201, type: "artist" },
    { id: 5806, name: "Thom Yorke", nb_album: 31, nb_fan: 163047, type: "artist" },
    { id: 12118220, name: "The Smile", nb_album: 8, nb_fan: 43308, type: "artist" },
  ],
  total: 20,
};

describe("mapSimilarArtists", () => {
  it("scores the first result 1.0 and decays by position", () => {
    const artists = mapSimilarArtists(RELATED, 5);
    expect(artists.map((a) => a.score)).toEqual([1, 0.8, 0.6, 0.4, 0.2]);
  });

  it("preserves Deezer's ordering rather than re-sorting by popularity", () => {
    const artists = mapSimilarArtists(RELATED, 5);
    // Jeff Buckley (322k fans) leads The Smashing Pumpkins (1.76M) — the order
    // carries similarity signal that a popularity sort would destroy.
    expect(artists.map((a) => a.name)).toEqual([
      "Jeff Buckley",
      "The Smashing Pumpkins",
      "Blur",
      "Thom Yorke",
      "The Smile",
    ]);
  });

  it("carries the Deezer id so follow-up calls skip a search", () => {
    expect(mapSimilarArtists(RELATED, 5)[0]).toEqual({
      name: "Jeff Buckley",
      externalId: "664",
      score: 1,
    });
  });

  it("renormalises when fewer results come back than were asked for", () => {
    const artists = mapSimilarArtists({ data: RELATED.data.slice(0, 2) }, 20);
    expect(artists.map((a) => a.score)).toEqual([1, 0.5]);
  });

  it("truncates to the requested limit", () => {
    expect(mapSimilarArtists(RELATED, 2).map((a) => a.name)).toEqual([
      "Jeff Buckley",
      "The Smashing Pumpkins",
    ]);
  });

  it("survives an error body, an empty list and malformed rows", () => {
    expect(mapSimilarArtists({ error: { type: "DataException", code: 800 } }, 20)).toEqual([]);
    expect(mapSimilarArtists({ data: [], total: 0 }, 20)).toEqual([]);
    // Unusable rows must not consume a rank: the one real neighbour is still
    // the closest one Deezer returned and has to score 1.
    expect(mapSimilarArtists({ data: [{ id: 1 }, "junk", { id: 2, name: "Blur" }] }, 20)).toEqual([
      { name: "Blur", externalId: "2", score: 1 },
    ]);
  });

  it("fills the requested limit with usable rows rather than counting dropped ones", () => {
    const withHoles = { data: [{ id: 1 }, ...RELATED.data.slice(0, 3)] };
    const artists = mapSimilarArtists(withHoles, 2);
    expect(artists.map((a) => a.name)).toEqual(["Jeff Buckley", "The Smashing Pumpkins"]);
    expect(artists.map((a) => a.score)).toEqual([1, 0.5]);
  });
});
