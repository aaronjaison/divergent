import { describe, expect, it } from "vitest";
import { countByArtist } from "./diversity";
import { constraints, makeArtist, makeTrack } from "./fixtures";
import { buildBlend, buildDeepCuts, buildFamous } from "./introduceMe";
import type { EngineArtist } from "./types";

const discography: EngineArtist = makeArtist("Bjork", {
  popularity: 70,
  albums: [
    { title: "Debut", year: 1993, trackCount: 8 },
    { title: "Post", year: 1995, trackCount: 8 },
    { title: "Homogenic", year: 1997, trackCount: 8 },
    { title: "Vespertine", year: 2001, trackCount: 8 },
  ],
});

describe("buildFamous", () => {
  it("orders by popularity, most famous first", () => {
    const { tracks } = buildFamous({
      artist: discography,
      constraints: constraints({ targetLength: 10 }),
    });

    expect(tracks).toHaveLength(10);
    for (let i = 1; i < tracks.length; i++) {
      expect(tracks[i].popularity).toBeLessThanOrEqual(
        tracks[i - 1].popularity as number,
      );
    }
    expect(tracks[0].reason).toMatch(/best-known/);
  });

  it("says so rather than pretending when no popularity data exists", () => {
    const unranked: EngineArtist = {
      key: "Unknown Band",
      name: "Unknown Band",
      tagAffinity: {},
      tracks: [
        makeTrack("Unknown Band", "First"),
        makeTrack("Unknown Band", "Second"),
      ],
    };

    const { tracks, warnings } = buildFamous({
      artist: unranked,
      constraints: constraints({ targetLength: 5 }),
    });

    expect(tracks).toHaveLength(2);
    expect(warnings.join(" ")).toMatch(/No popularity data/i);
    expect(tracks[0].reason).not.toMatch(/best-known/);
  });

  it("warns when the catalogue is shorter than requested", () => {
    const { warnings } = buildFamous({
      artist: discography,
      constraints: constraints({ targetLength: 100 }),
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("tops up a long request from the albums when the charts run out", () => {
    // Only 6 tracks carry chart popularity; the album pool supplies the rest.
    const charting: EngineArtist = {
      key: "Bjork",
      name: "Bjork",
      tagAffinity: {},
      tracks: discography.tracks.slice(0, 6),
    };

    const { tracks, warnings } = buildFamous({
      artist: charting,
      constraints: constraints({ targetLength: 20 }),
      supplement: discography.tracks.slice(6),
    });

    expect(tracks).toHaveLength(20);
    expect(warnings.join(" ")).toMatch(/album/i);
    // The real hits keep the front of the playlist and their own explanation.
    expect(tracks.slice(0, 6).every((t) => t.reason?.includes("best-known"))).toBe(true);
    expect(tracks[19].reason).toMatch(/standout|catalogue/i);
  });

  it("never lets a supplement track displace a charting one", () => {
    const charting: EngineArtist = {
      key: "Bjork",
      name: "Bjork",
      tagAffinity: {},
      tracks: [makeTrack("Bjork", "Actual Hit", { popularity: 40 })],
    };

    const { tracks } = buildFamous({
      artist: charting,
      constraints: constraints({ targetLength: 3 }),
      // Album-normalised 100 means "best track on a quiet record", not "hit".
      supplement: [
        makeTrack("Bjork", "Album Opener", { popularity: 100 }),
        makeTrack("Bjork", "Album Filler", { popularity: 20 }),
      ],
    });

    expect(tracks[0].title).toBe("Actual Hit");
  });

  it("drops a supplement track that duplicates a charting one", () => {
    const charting: EngineArtist = {
      key: "Bjork",
      name: "Bjork",
      tagAffinity: {},
      tracks: [makeTrack("Bjork", "Hyperballad", { popularity: 90 })],
    };

    const { tracks } = buildFamous({
      artist: charting,
      constraints: constraints({ targetLength: 5 }),
      supplement: [
        makeTrack("Bjork", "Hyperballad", { key: "other-id", popularity: 100 }),
        makeTrack("Bjork", "Isobel", { popularity: 80 }),
      ],
    });

    expect(tracks.map((t) => t.title)).toEqual(["Hyperballad", "Isobel"]);
  });
});

describe("buildDeepCuts", () => {
  it("spreads across albums and never exceeds the per-album cap", () => {
    const { tracks } = buildDeepCuts({
      artist: discography,
      constraints: constraints({ targetLength: 12 }),
      maxPerAlbum: 2,
    });

    const perAlbum = new Map<string, number>();
    for (const track of tracks) {
      const key = track.album ?? "?";
      perAlbum.set(key, (perAlbum.get(key) ?? 0) + 1);
    }

    expect(perAlbum.size).toBeGreaterThanOrEqual(3);
    for (const count of perAlbum.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it("orders chronologically so the playlist tells a career story", () => {
    const { tracks } = buildDeepCuts({
      artist: discography,
      constraints: constraints({ targetLength: 12 }),
    });

    for (let i = 1; i < tracks.length; i++) {
      expect(tracks[i].year as number).toBeGreaterThanOrEqual(
        tracks[i - 1].year as number,
      );
    }
  });

  it("avoids the artist's best-known tracks", () => {
    const famous = buildFamous({
      artist: discography,
      constraints: constraints({ targetLength: 10 }),
    });
    const excludeKeys = new Set(famous.tracks.map((t) => t.key));

    const { tracks } = buildDeepCuts({
      artist: discography,
      constraints: constraints({ targetLength: 12 }),
      excludeKeys,
    });

    for (const track of tracks) {
      expect(excludeKeys.has(track.key)).toBe(false);
    }
  });

  it("picks the least popular tracks on each album", () => {
    const { tracks } = buildDeepCuts({
      artist: discography,
      constraints: constraints({ targetLength: 8 }),
      maxPerAlbum: 2,
    });

    // Fixture albums descend 100 -> 0 across 8 tracks; the tail sits under 50.
    for (const track of tracks) {
      expect(track.popularity as number).toBeLessThan(50);
    }
  });

  it("explains where each track came from", () => {
    const { tracks } = buildDeepCuts({
      artist: discography,
      constraints: constraints({ targetLength: 4 }),
    });
    expect(tracks[0].reason).toMatch(/deep cut from .+ \(\d{4}\)/);
  });

  it("returns a warning instead of throwing when everything is excluded", () => {
    const excludeKeys = new Set(discography.tracks.map((t) => t.key));
    const { tracks, warnings } = buildDeepCuts({
      artist: discography,
      constraints: constraints(),
      excludeKeys,
    });
    expect(tracks).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("buildBlend", () => {
  const similar = [
    { artist: makeArtist("Portishead", { popularity: 65, trackCount: 8 }), score: 0.9 },
    { artist: makeArtist("Massive Attack", { popularity: 60, trackCount: 8 }), score: 0.7 },
    { artist: makeArtist("Tricky", { popularity: 40, trackCount: 8 }), score: 0.5 },
    { artist: makeArtist("Goldfrapp", { popularity: 50, trackCount: 8 }), score: 0.3 },
  ];

  it("gives the seed artist a meaningful but minority share", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20, maxPerArtist: 3 }),
    });

    const seedCount = tracks.filter((t) => t.artistKey === "Bjork").length;
    expect(seedCount).toBeGreaterThan(2);
    expect(seedCount).toBeLessThan(tracks.length / 2);
  });

  it("opens with the artist the listener asked about", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20 }),
    });
    expect(tracks[0].artistKey).toBe("Bjork");
  });

  it("returns to the seed artist regularly rather than front-loading", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20, maxPerArtist: 3 }),
    });

    const positions = tracks
      .map((track, index) => (track.artistKey === "Bjork" ? index : -1))
      .filter((index) => index >= 0);

    expect(positions.length).toBeGreaterThan(1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(5);
    }
  });

  it("favours the most similar artists", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20, maxPerArtist: 3 }),
    });

    const counts = countByArtist(tracks);
    expect(counts.get("Portishead") ?? 0).toBeGreaterThanOrEqual(
      counts.get("Goldfrapp") ?? 0,
    );
  });

  it("never repeats an artist back to back", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20, maxPerArtist: 3 }),
    });
    for (let i = 1; i < tracks.length; i++) {
      expect(tracks[i].artistKey).not.toBe(tracks[i - 1].artistKey);
    }
  });

  it("degrades to the seed artist alone when nothing similar is known", () => {
    const { tracks, warnings } = buildBlend({
      seedArtist: discography,
      similar: [],
      constraints: constraints({ targetLength: 10 }),
    });

    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t.artistKey === "Bjork")).toBe(true);
    expect(warnings.join(" ")).toMatch(/No similar artists/i);
  });

  it("reaches the requested length when the seed has a deep catalogue", () => {
    const deep = makeArtist("Bjork", { trackCount: 120, popularity: 70 });
    const many = Array.from({ length: 90 }, (_, i) => ({
      artist: makeArtist(`Similar ${i}`, { trackCount: 10 }),
      score: 0.9 - i * 0.005,
    }));

    const { tracks, warnings } = buildBlend({
      seedArtist: deep,
      similar: many,
      constraints: constraints({ targetLength: 200, maxPerArtist: 2, obscurity: "hard" }),
    });

    expect(tracks).toHaveLength(200);
    expect(warnings).toHaveLength(0);
  });

  it("hands the seed's unused slots to the neighbours", () => {
    // Twelve tracks cannot cover 35% of a 100-track playlist. The neighbours
    // should absorb the difference rather than the playlist coming up short.
    const thin = makeArtist("Bjork", { trackCount: 12, popularity: 70 });
    const many = Array.from({ length: 60 }, (_, i) => ({
      artist: makeArtist(`Similar ${i}`, { trackCount: 10 }),
      score: 0.9 - i * 0.01,
    }));

    const { tracks } = buildBlend({
      seedArtist: thin,
      similar: many,
      constraints: constraints({ targetLength: 100, maxPerArtist: 2 }),
    });

    expect(tracks).toHaveLength(100);
    expect(countByArtist(tracks).get("Bjork")).toBeLessThanOrEqual(12);
  });

  it("respects maxPerArtist across the whole blend", () => {
    const { tracks } = buildBlend({
      seedArtist: discography,
      similar,
      constraints: constraints({ targetLength: 20, maxPerArtist: 2 }),
    });

    for (const [artist, count] of countByArtist(tracks)) {
      if (artist === "Bjork") continue; // the seed is allowed its larger share
      expect(count).toBeLessThanOrEqual(2);
    }
  });
});
