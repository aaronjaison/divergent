import { NextResponse } from "next/server";
import {
  findPlaylist,
  getPlaylistTracks,
  saveSoundiizHandoff,
} from "@/lib/db/repo/playlists";
import {
  createSoundiizImport,
  isHandoffValid,
  SoundiizError,
} from "@/lib/export/soundiiz";

/**
 * POST only, and only from a user click: Soundiiz share links live ~24h, so
 * generating one ahead of time usually hands over a dead link.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const playlist = findPlaylist(id);

  if (!playlist) {
    return NextResponse.json({ error: "Playlist not found" }, { status: 404 });
  }

  // Reuse a live link rather than burning another request on the endpoint.
  if (playlist.soundiizUrl && isHandoffValid(playlist.soundiizExpiresAt)) {
    return NextResponse.json({
      shareUrl: playlist.soundiizUrl,
      expiresAt: playlist.soundiizExpiresAt,
      reused: true,
    });
  }

  const tracks = getPlaylistTracks(id);
  if (tracks.length === 0) {
    return NextResponse.json(
      { error: "This playlist has no tracks yet" },
      { status: 409 },
    );
  }

  try {
    const handoff = await createSoundiizImport({
      title: playlist.title,
      description: "Built with Divergent",
      tracks,
    });

    saveSoundiizHandoff(id, handoff.shareUrl, handoff.expiresAt);

    return NextResponse.json({
      shareUrl: handoff.shareUrl,
      expiresAt: handoff.expiresAt,
      trackCount: handoff.trackCount,
      reused: false,
    });
  } catch (error) {
    const message =
      error instanceof SoundiizError
        ? error.message
        : "Could not create the transfer link. You can still download this playlist as CSV.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
