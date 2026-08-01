import type { PlaylistTrack } from "@/lib/db/repo/playlists";

/**
 * File exports.
 *
 * These read only the denormalised snapshot stored on playlist_tracks, so they
 * keep working after purge-noncommercial.ts clears provider data. They are also
 * the permanent fallback if the Soundiiz handoff ever changes or disappears —
 * every transfer service on the market ingests CSV or "Artist - Title" text.
 */

export function joinArtists(names: readonly string[]): string {
  return names.join("; ");
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // RFC 4180: quote when the cell contains a delimiter, quote or newline.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function secondsOf(durationMs: number | null | undefined): number | "" {
  return durationMs ? Math.round(durationMs / 1000) : "";
}

/**
 * Column order matches what Soundiiz and TuneMyMusic expect from a manual
 * upload. ISRC is included because it lifts their match rate substantially.
 */
export function toCsv(tracks: readonly PlaylistTrack[]): string {
  const header = ["Title", "Artist", "Album", "ISRC", "Duration", "Year"];
  const rows = tracks.map((track) =>
    [
      csvCell(track.title),
      csvCell(joinArtists(track.artistNames)),
      csvCell(track.album),
      csvCell(track.isrc),
      csvCell(secondsOf(track.durationMs)),
      csvCell(track.year),
    ].join(","),
  );
  return [header.join(","), ...rows].join("\r\n");
}

/** "Artist - Title" per line: what TuneMyMusic's paste box accepts directly. */
export function toText(tracks: readonly PlaylistTrack[]): string {
  return tracks
    .map((track) => `${joinArtists(track.artistNames)} - ${track.title}`)
    .join("\n");
}

/** Extended M3U for local players. Streaming services ignore this format. */
export function toM3u(tracks: readonly PlaylistTrack[], title: string): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${title}`];
  for (const track of tracks) {
    const seconds = track.durationMs ? Math.round(track.durationMs / 1000) : -1;
    lines.push(`#EXTINF:${seconds},${joinArtists(track.artistNames)} - ${track.title}`);
    // No local file path exists, so the human-readable line doubles as the entry.
    lines.push(`${joinArtists(track.artistNames)} - ${track.title}`);
  }
  return lines.join("\n");
}

export type ExportFormat = "csv" | "txt" | "m3u";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  m3u: "audio/x-mpegurl; charset=utf-8",
};

export function safeFilename(title: string, format: ExportFormat): string {
  const base =
    title
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "playlist";
  return `${base}.${format}`;
}

export function renderExport(
  tracks: readonly PlaylistTrack[],
  title: string,
  format: ExportFormat,
): string {
  switch (format) {
    case "csv":
      return toCsv(tracks);
    case "txt":
      return toText(tracks);
    case "m3u":
      return toM3u(tracks, title);
  }
}
