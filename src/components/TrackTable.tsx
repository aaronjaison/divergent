import type { PlaylistTrack } from "@/lib/db/repo/playlists";
import { TrackLinks } from "./TrackLinks";

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function TrackTable({ tracks }: { tracks: PlaylistTrack[] }) {
  if (tracks.length === 0) {
    return (
      <p className="rounded-lg border border-border p-6 text-sm text-muted">
        No tracks yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[38rem] text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="w-10 px-4 py-3 font-medium">#</th>
            <th className="px-4 py-3 font-medium">Track</th>
            <th className="px-4 py-3 font-medium">Release</th>
            <th className="w-16 px-4 py-3 text-right font-medium">Length</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => (
            <tr
              key={`${track.position}-${track.title}`}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-3 text-muted tabular-nums">
                {track.position + 1}
              </td>
              <td className="px-4 py-3">
                <div className="font-medium">{track.title}</div>
                <div className="text-muted">{track.artistNames.join(", ")}</div>
                {track.reason && (
                  <div className="mt-0.5 text-xs text-muted italic">{track.reason}</div>
                )}
                <TrackLinks isrc={track.isrc} />
              </td>
              <td className="px-4 py-3 text-muted">
                {track.album ?? "—"}
                {track.year ? ` (${track.year})` : ""}
              </td>
              <td className="px-4 py-3 text-right text-muted tabular-nums">
                {formatDuration(track.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
