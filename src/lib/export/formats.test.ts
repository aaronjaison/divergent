import { describe, expect, it } from "vitest";
import type { PlaylistTrack } from "@/lib/db/repo/playlists";
import { renderExport, safeFilename, toCsv, toM3u, toText } from "./formats";
import { buildTracklist, isHandoffValid, SOUNDIIZ_MAX_TRACKS } from "./soundiiz";

function track(overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return {
    position: 0,
    recordingId: null,
    title: "Souvlaki Space Station",
    artistNames: ["Slowdive"],
    album: "Souvlaki",
    isrc: "GBAAA9300001",
    durationMs: 366_000,
    year: 1993,
    reason: null,
    ...overrides,
  };
}

describe("toCsv", () => {
  it("writes a header and one row per track", () => {
    const csv = toCsv([track(), track({ title: "Alison" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Title,Artist,Album,ISRC,Duration,Year");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("Souvlaki Space Station,Slowdive,Souvlaki,GBAAA9300001,366,1993");
  });

  it("quotes cells containing commas, quotes or newlines", () => {
    const csv = toCsv([
      track({ title: 'Weird, "Quoted" Title', artistNames: ["A, B"] }),
    ]);
    expect(csv).toContain('"Weird, ""Quoted"" Title"');
    expect(csv).toContain('"A, B"');
  });

  it("leaves missing fields empty rather than printing null", () => {
    const csv = toCsv([
      track({ album: null, isrc: null, durationMs: null, year: null }),
    ]);
    const row = csv.split("\r\n")[1];
    expect(row).toBe("Souvlaki Space Station,Slowdive,,,,");
    expect(csv).not.toContain("null");
  });

  it("joins multiple artists with a separator transfer tools understand", () => {
    const csv = toCsv([track({ artistNames: ["Slowdive", "Mojave 3"] })]);
    expect(csv).toContain("Slowdive; Mojave 3");
  });

  it("handles an empty playlist without dropping the header", () => {
    expect(toCsv([])).toBe("Title,Artist,Album,ISRC,Duration,Year");
  });
});

describe("toText", () => {
  it("writes the Artist - Title form transfer sites paste-import", () => {
    expect(toText([track(), track({ title: "Alison" })])).toBe(
      "Slowdive - Souvlaki Space Station\nSlowdive - Alison",
    );
  });
});

describe("toM3u", () => {
  it("writes a valid extended-M3U header and per-track duration in seconds", () => {
    const m3u = toM3u([track()], "Shoegaze");
    const lines = m3u.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#PLAYLIST:Shoegaze");
    expect(lines[2]).toBe("#EXTINF:366,Slowdive - Souvlaki Space Station");
  });

  it("uses -1 for unknown durations, as the format requires", () => {
    expect(toM3u([track({ durationMs: null })], "x")).toContain("#EXTINF:-1,");
  });
});

describe("safeFilename", () => {
  it("strips characters that are illegal in filenames", () => {
    expect(safeFilename('Shoegaze: 1990/1995 <best>', "csv")).toBe(
      "Shoegaze-19901995-best.csv",
    );
  });

  it("falls back to a default when nothing usable remains", () => {
    expect(safeFilename("///", "txt")).toBe("playlist.txt");
  });
});

describe("renderExport", () => {
  it("dispatches on format", () => {
    const tracks = [track()];
    expect(renderExport(tracks, "t", "csv")).toContain("Title,Artist");
    expect(renderExport(tracks, "t", "txt")).toBe("Slowdive - Souvlaki Space Station");
    expect(renderExport(tracks, "t", "m3u")).toContain("#EXTM3U");
  });
});

describe("soundiiz handoff", () => {
  it("sends the ISRC, album and duration, not just the name", () => {
    // Title and artist alone is a text search, and it misses remasters, live
    // versions and common titles — the songs people then find by hand and
    // wonder why the transfer could not. Soundiiz documents isrc and album as
    // matching attributes and round-trips duration in its own export format.
    expect(buildTracklist([track()])).toEqual([
      {
        title: "Souvlaki Space Station",
        artists: ["Slowdive"],
        album: "Souvlaki",
        isrc: "GBAAA9300001",
        duration: 366,
      },
    ]);
  });

  it("omits fields it does not have rather than sending them empty", () => {
    // A blank ISRC is a claim about the recording; an absent one is not.
    expect(
      buildTracklist([track({ album: null, isrc: null, durationMs: null })]),
    ).toEqual([{ title: "Souvlaki Space Station", artists: ["Slowdive"] }]);
  });

  it("truncates to the API's 200-track ceiling", () => {
    const many = Array.from({ length: 250 }, (_, i) => track({ title: `T${i}` }));
    expect(buildTracklist(many)).toHaveLength(SOUNDIIZ_MAX_TRACKS);
  });

  it("treats a link expiring imminently as already gone", () => {
    const now = Date.now();
    expect(isHandoffValid(now + 3_600_000, now)).toBe(true);
    expect(isHandoffValid(now + 30_000, now)).toBe(false);
    expect(isHandoffValid(now - 1, now)).toBe(false);
    expect(isHandoffValid(null, now)).toBe(false);
  });
});
