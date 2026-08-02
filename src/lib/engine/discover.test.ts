import { describe, expect, it } from "vitest";
import { buildDiscovery } from "./discover";
import { countByArtist } from "./diversity";
import { constraints, makeArtist, makeTrack } from "./fixtures";
import type { EngineArtist } from "./types";

/** `count` neighbours whose similarity falls off evenly from 0.9. */
function neighbours(
  count: number,
  trackCount = 10,
): { artist: EngineArtist; score: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    artist: makeArtist(`Neighbour ${i + 1}`, { trackCount }),
    score: 0.9 - i * (0.5 / Math.max(1, count)),
  }));
}

describe("buildDiscovery", () => {
  it("never includes the seed artist", () => {
    const seed = makeArtist("Slowdive", { trackCount: 10 });

    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: [
        { artist: seed, score: 1 },
        ...neighbours(10),
      ],
      constraints: constraints({ targetLength: 10, maxPerArtist: 1 }),
      excludeArtistKeys: new Set(["Slowdive"]),
    });

    expect(tracks).toHaveLength(10);
    expect(tracks.some((track) => track.artistKey === "Slowdive")).toBe(false);
  });

  it("gives one track each, so the playlist is as wide as it is long", () => {
    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(30),
      constraints: constraints({ targetLength: 25, maxPerArtist: 1 }),
    });

    expect(tracks).toHaveLength(25);
    expect(new Set(tracks.map((t) => t.artistKey)).size).toBe(25);
  });

  it("fills a 200-track request when the pool is deep enough", () => {
    const { tracks, warnings } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(220),
      constraints: constraints({ targetLength: 200, maxPerArtist: 1 }),
    });

    expect(tracks).toHaveLength(200);
    expect(warnings).toHaveLength(0);
  });

  it("honours the per-artist cap and never repeats an artist back to back", () => {
    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(12),
      constraints: constraints({ targetLength: 24, maxPerArtist: 2 }),
    });

    for (const count of countByArtist(tracks).values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
    for (let i = 1; i < tracks.length; i++) {
      expect(tracks[i].artistKey).not.toBe(tracks[i - 1].artistKey);
    }
  });

  it("leads with the closest matches", () => {
    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(20),
      constraints: constraints({ targetLength: 5, maxPerArtist: 1 }),
    });

    // Neighbour 1 is the strongest score, so it should be in the opening few
    // rather than buried by the merge.
    expect(tracks.slice(0, 3).map((t) => t.artistKey)).toContain("Neighbour 1");
  });

  it("relaxes the cap rather than returning short, and says so", () => {
    const { tracks, warnings } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(8),
      constraints: constraints({ targetLength: 16, maxPerArtist: 1 }),
    });

    expect(tracks.length).toBeGreaterThan(8);
    expect(warnings.join(" ")).toMatch(/tracks per artist/i);
  });

  it("demotes household names in hard mode and keeps them in easy mode", () => {
    // Similarity descends with the index while fame ascends, so ranking on
    // similarity alone would put the most famous artists last and hide the
    // bug. Here the two pull against each other, which is the real case:
    // co-listening puts the biggest names at the TOP of the list.
    const candidates = Array.from({ length: 20 }, (_, i) => ({
      artist: makeArtist(`Artist ${i}`, {
        trackCount: 8,
        // Artist 0 is the most similar AND the most famous.
        popularity: 100 - i * 5,
      }),
      score: 0.9 - i * 0.02,
    }));

    const famousKeys = new Set(["Artist 0", "Artist 1", "Artist 2", "Artist 3"]);

    const hard = buildDiscovery({
      seedArtistName: "Radiohead",
      similar: candidates,
      constraints: constraints({ targetLength: 8, maxPerArtist: 1, obscurity: "hard" }),
    });
    const easy = buildDiscovery({
      seedArtistName: "Radiohead",
      similar: candidates,
      constraints: constraints({ targetLength: 8, maxPerArtist: 1, obscurity: "easy" }),
    });

    const famousIn = (r: { tracks: { artistKey: string }[] }) =>
      r.tracks.filter((t) => famousKeys.has(t.artistKey)).length;

    expect(famousIn(hard)).toBeLessThan(famousIn(easy));
  });

  it("treats unknown audience size as average, not as obscure", () => {
    const unknown = makeArtist("Unmeasured", { trackCount: 8 });
    const measured = Array.from({ length: 10 }, (_, i) => ({
      artist: makeArtist(`Known ${i}`, { trackCount: 8, popularity: i * 10 }),
      score: 0.5,
    }));

    const { tracks } = buildDiscovery({
      seedArtistName: "Radiohead",
      similar: [{ artist: unknown, score: 0.5 }, ...measured],
      constraints: constraints({ targetLength: 11, maxPerArtist: 1, obscurity: "hard" }),
    });

    // Present, but not promoted to the front for lacking a number.
    expect(tracks.some((t) => t.artistKey === "Unmeasured")).toBe(true);
    expect(tracks[0].artistKey).not.toBe("Unmeasured");
  });

  it("reports honestly when there is nothing similar to work with", () => {
    const { tracks, warnings } = buildDiscovery({
      seedArtistName: "Some Unknown",
      similar: [],
      constraints: constraints({ targetLength: 20 }),
    });

    expect(tracks).toHaveLength(0);
    expect(warnings.join(" ")).toMatch(/No artists similar to Some Unknown/i);
  });

  it("drops neighbours whose tracks all fail the filters", () => {
    const liveOnly: EngineArtist = {
      key: "Live Band",
      name: "Live Band",
      tagAffinity: {},
      tracks: [
        makeTrack("Live Band", "Something (Live at Wembley)", { popularity: 90 }),
        makeTrack("Live Band", "Another Thing - Live", { popularity: 80 }),
      ],
    };

    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: [{ artist: liveOnly, score: 1 }, ...neighbours(5)],
      constraints: constraints({ targetLength: 5, maxPerArtist: 1 }),
    });

    expect(tracks.some((track) => track.artistKey === "Live Band")).toBe(false);
  });

  it("explains each track by naming the artist it was matched against", () => {
    const { tracks } = buildDiscovery({
      seedArtistName: "Slowdive",
      similar: neighbours(5),
      constraints: constraints({ targetLength: 5, maxPerArtist: 1 }),
    });

    for (const track of tracks) {
      expect(track.reason).toBe("sounds like Slowdive");
    }
  });
});
