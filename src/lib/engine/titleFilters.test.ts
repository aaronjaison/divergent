import { describe, expect, it } from "vitest";
import { constraints, makeTrack } from "./fixtures";
import {
  dedupeTracks,
  isExcludedAlbumTitle,
  isExcludedReleaseType,
  isExcludedTitle,
  passesFilters,
} from "./titleFilters";

describe("isExcludedTitle", () => {
  it("drops alternate takes that pad out a playlist", () => {
    for (const title of [
      "Karma Police (Live at Reading)",
      "Teardrop (Mad Professor Remix)",
      "Separator (Anstam RMX)",
      "Idioteque - Radio Edit",
      "Skit 3",
      "Interlude",
      "Untitled (Demo)",
      "Song (Instrumental)",
    ]) {
      expect(isExcludedTitle(title), title).toBe(true);
    }
  });

  it("keeps songs whose titles merely contain a trigger word", () => {
    for (const title of [
      "Live Forever",
      "Livewire",
      "Sessions of Love",
      "Introduction to Nothing",
    ]) {
      expect(isExcludedTitle(title), title).toBe(false);
    }
  });
});

describe("isExcludedAlbumTitle", () => {
  it("rejects remix, live and compilation releases", () => {
    // The popularity provider only distinguishes album from single, so a remix
    // album otherwise looks like a studio record full of unfamiliar tracks —
    // exactly what a deep-cuts search would seize on.
    for (const title of [
      "TKOL RMX 1234567",
      "In Rainbows: The Remixes",
      "Live at Wembley",
      "MTV Unplugged",
      "Greatest Hits",
      "The Best of Radiohead",
      "Anthology",
    ]) {
      expect(isExcludedAlbumTitle(title), title).toBe(true);
    }
  });

  it("keeps ordinary studio albums", () => {
    for (const title of ["OK Computer", "Kid A", "A Moon Shaped Pool", "Amnesiac"]) {
      expect(isExcludedAlbumTitle(title), title).toBe(false);
    }
  });
});

describe("isExcludedReleaseType", () => {
  it("uses MusicBrainz secondary types when they exist", () => {
    expect(isExcludedReleaseType(["Live"])).toBe(true);
    expect(isExcludedReleaseType(["Compilation"])).toBe(true);
    expect(isExcludedReleaseType([])).toBe(false);
    expect(isExcludedReleaseType(undefined)).toBe(false);
  });
});

describe("passesFilters", () => {
  it("keeps tracks of unknown duration but rejects out-of-range ones", () => {
    const base = constraints();
    expect(passesFilters(makeTrack("a", "Song", { durationMs: undefined }), base)).toBe(true);
    expect(passesFilters(makeTrack("a", "Song", { durationMs: 20_000 }), base)).toBe(false);
    expect(passesFilters(makeTrack("a", "Song", { durationMs: 20 * 60_000 }), base)).toBe(false);
  });

  it("treats an undated track as failing an explicit era request", () => {
    const era = constraints({ eraFrom: 1990, eraTo: 1999 });
    expect(passesFilters(makeTrack("a", "Song", { year: 1995 }), era)).toBe(true);
    expect(passesFilters(makeTrack("a", "Song", { year: 2005 }), era)).toBe(false);
    expect(passesFilters(makeTrack("a", "Song", { year: undefined }), era)).toBe(false);
  });

  it("refuses fuzzy matches in hard mode only", () => {
    const fuzzy = makeTrack("a", "Song", { matchConfidence: "fuzzy" });
    // In hard mode the listener recognises nothing, so a mismatched track is
    // undetectable — and therefore the most damaging.
    expect(passesFilters(fuzzy, constraints({ obscurity: "hard" }))).toBe(false);
    expect(passesFilters(fuzzy, constraints({ obscurity: "medium" }))).toBe(true);
  });
});

describe("dedupeTracks", () => {
  it("keeps one version of a song per artist", () => {
    const tracks = [
      makeTrack("radiohead", "Creep", { key: "1" }),
      makeTrack("radiohead", "Creep (Acoustic)", { key: "2" }),
      makeTrack("radiohead", "Creep - Live at Glastonbury", { key: "3" }),
    ];
    const result = dedupeTracks(tracks);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Creep");
  });

  it("allows the same song title from different artists", () => {
    const result = dedupeTracks([
      makeTrack("a", "Crazy", { key: "1" }),
      makeTrack("b", "Crazy", { key: "2" }),
    ]);
    expect(result).toHaveLength(2);
  });

  it("drops exact key repeats", () => {
    const result = dedupeTracks([
      makeTrack("a", "One", { key: "same" }),
      makeTrack("a", "Two", { key: "same" }),
    ]);
    expect(result).toHaveLength(1);
  });
});
