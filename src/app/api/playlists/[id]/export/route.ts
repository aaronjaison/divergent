import { NextResponse } from "next/server";
import { z } from "zod";
import { findPlaylist, getPlaylistTracks } from "@/lib/db/repo/playlists";
import {
  EXPORT_MIME,
  renderExport,
  safeFilename,
  type ExportFormat,
} from "@/lib/export/formats";

const formatSchema = z.enum(["csv", "txt", "m3u"]).catch("csv");

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const playlist = findPlaylist(id);

  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  const format: ExportFormat = formatSchema.parse(
    new URL(request.url).searchParams.get("format"),
  );
  const tracks = getPlaylistTracks(id);

  if (tracks.length === 0) {
    return NextResponse.json(
      { error: "This playlist has no tracks yet" },
      { status: 409 },
    );
  }

  return new NextResponse(renderExport(tracks, playlist.title, format), {
    headers: {
      "Content-Type": EXPORT_MIME[format],
      "Content-Disposition": `attachment; filename="${safeFilename(playlist.title, format)}"`,
      "Cache-Control": "no-store",
    },
  });
}
