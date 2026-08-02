import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ db: {}, schema: {} }));

const mbFetch = vi.fn();

// Only the transport is replaced; the schemas and licence rules stay real, so a
// change to either still fails this suite.
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  mbFetch,
}));

const { musicbrainzTags } = await import("./tags");

/** A full page of otherwise-identical artists, each with `votes` for the tag. */
function page(from: number, count: number, votes: number, tag = "shoegaze") {
  return {
    count: 1000,
    artists: Array.from({ length: count }, (_, i) => ({
      // MBIDs only have to be distinct here; nothing parses their contents.
      id: `00000000-0000-4000-8000-${String(from + i).padStart(12, "0")}`,
      name: `Artist ${from + i}`,
      score: 100 - i,
      tags: [{ count: votes, name: tag }],
    })),
  };
}

beforeEach(() => {
  mbFetch.mockReset();
});

describe("musicbrainzTags.getArtistsForTag paging", () => {
  it("makes one call for a request that fits in a single page", async () => {
    mbFetch.mockResolvedValueOnce(page(0, 100, 5));

    const result = await musicbrainzTags.getArtistsForTag("shoegaze", 60);

    expect(mbFetch).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(60);
    // No offset on the first page, so every cache entry written before paging
    // existed still answers this request.
    expect(mbFetch.mock.calls[0][1]).toMatchObject({ limit: 100 });
    expect(mbFetch.mock.calls[0][1].offset).toBeUndefined();
  });

  it("pages until the request is covered", async () => {
    mbFetch
      .mockResolvedValueOnce(page(0, 100, 5))
      .mockResolvedValueOnce(page(100, 100, 5))
      .mockResolvedValueOnce(page(200, 100, 5));

    const result = await musicbrainzTags.getArtistsForTag("shoegaze", 250);

    expect(mbFetch).toHaveBeenCalledTimes(3);
    expect(mbFetch.mock.calls[1][1]).toMatchObject({ offset: 100 });
    expect(mbFetch.mock.calls[2][1]).toMatchObject({ offset: 200 });
    expect(result.data).toHaveLength(250);
  });

  it("stops when a short page shows the tag is exhausted", async () => {
    mbFetch
      .mockResolvedValueOnce(page(0, 100, 5))
      .mockResolvedValueOnce({ count: 130, artists: page(100, 30, 5).artists });

    const result = await musicbrainzTags.getArtistsForTag("shoegaze", 400);

    expect(mbFetch).toHaveBeenCalledTimes(2);
    expect(result.data).toHaveLength(130);
  });

  it("stops when the reported total has been read", async () => {
    mbFetch.mockResolvedValueOnce({
      count: 100,
      artists: page(0, 100, 5).artists,
    });

    await musicbrainzTags.getArtistsForTag("shoegaze", 400);
    expect(mbFetch).toHaveBeenCalledTimes(1);
  });

  it("ranks across the whole pool, not page by page", async () => {
    // Lucene relevance put these on page two, but they have far more votes for
    // the tag than anything on page one — which is the reason to page at all.
    mbFetch
      .mockResolvedValueOnce(page(0, 100, 1))
      .mockResolvedValueOnce(page(100, 100, 50));

    const result = await musicbrainzTags.getArtistsForTag("shoegaze", 150);

    expect(result.data[0].name).toMatch(/Artist 1\d\d/);
  });

  it("survives a page that fails to fetch", async () => {
    mbFetch.mockResolvedValueOnce(page(0, 100, 5)).mockResolvedValueOnce(null);

    const result = await musicbrainzTags.getArtistsForTag("shoegaze", 200);
    expect(result.data).toHaveLength(100);
  });

  it("costs nothing for an empty tag", async () => {
    const result = await musicbrainzTags.getArtistsForTag("   ", 200);
    expect(mbFetch).not.toHaveBeenCalled();
    expect(result.data).toEqual([]);
  });
});
