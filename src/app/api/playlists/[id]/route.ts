import { NextResponse } from "next/server";
import {
  findPlaylist,
  getPlaylistTracks,
  parseWarnings,
} from "@/lib/db/repo/playlists";

/** Polled by the playlist page while a generation is running. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const playlist = findPlaylist(id);

  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const tracks = getPlaylistTracks(id);

  return NextResponse.json(
    {
      id: playlist.id,
      title: playlist.title,
      kind: playlist.kind,
      status: playlist.status,
      warnings: parseWarnings(playlist),
      progress: {
        done: playlist.progressDone,
        total: playlist.progressTotal,
        label: playlist.progressLabel,
      },
      trackCount: tracks.length,
      tracks,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
