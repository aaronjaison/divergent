import Link from "next/link";
import { notFound } from "next/navigation";
import { ExportToolbar } from "@/components/ExportToolbar";
import { GenerationProgress } from "@/components/GenerationProgress";
import { TrackTable } from "@/components/TrackTable";
import {
  findPlaylist,
  getPlaylistTracks,
  parseWarnings,
} from "@/lib/db/repo/playlists";

export const dynamic = "force-dynamic";

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const playlist = findPlaylist(id);
  if (!playlist) notFound();

  const tracks = getPlaylistTracks(id);
  const warnings = parseWarnings(playlist);
  const building = playlist.status === "building";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Playlist</p>
        <h1 className="font-display mt-3 text-4xl text-balance sm:text-5xl">
          {playlist.title}
        </h1>
        <p className="mt-3 text-sm text-muted">
          {building
            ? "Building…"
            : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {building && (
        <GenerationProgress
          playlistId={id}
          initialLabel={playlist.progressLabel}
          initialDone={playlist.progressDone}
          initialTotal={playlist.progressTotal}
        />
      )}

      {playlist.status === "failed" && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-5">
          <p className="text-sm font-medium">This playlist could not be built.</p>
          {warnings.map((warning) => (
            <p key={warning} className="mt-1 text-sm text-muted">
              {warning}
            </p>
          ))}
          <Link
            href="/"
            className="mt-3 inline-block text-sm underline hover:text-foreground"
          >
            Start over
          </Link>
        </div>
      )}

      {warnings.length > 0 && playlist.status !== "failed" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
          {warnings.map((warning) => (
            <p key={warning} className="text-sm text-muted">
              {warning}
            </p>
          ))}
        </div>
      )}

      {tracks.length > 0 && (
        <>
          <TrackTable tracks={tracks} />
          <ExportToolbar playlistId={id} trackCount={tracks.length} />
        </>
      )}
    </div>
  );
}
