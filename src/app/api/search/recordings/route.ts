import { NextResponse } from "next/server";
import { catalog } from "@/lib/providers/registry";

/**
 * Candidate recording ids sent per song.
 *
 * MusicBrainz holds one recording per distinct performance, so a much-released
 * song has dozens — "Only Shallow" has 26, "Karma Police" 98. They are ordered
 * best-first by recordingConfidence and the similarity lookup stops at the
 * first that answers, so the tail past a dozen would never be reached; sending
 * it only inflates the payload and the request the client posts back.
 */
const MAX_SEED_IDS = 12;

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({ recordings: [] });
  }

  try {
    // Abandoned when the client types past it — see the albums route.
    const result = await catalog.searchRecordings(query, 8, request.signal);
    return NextResponse.json(
      {
        recordings: result.data.map((recording) => ({
          // Every candidate id travels to the client and back, because which of
          // them the similarity index knows about is only discoverable by
          // asking — see ScoredRecordingRef.
          mbids: recording.mbids.slice(0, MAX_SEED_IDS),
          title: recording.title,
          artistNames: recording.artistNames,
          artistMbid: recording.artistMbid,
          album: recording.album,
          albumMbid: recording.albumMbid,
          year: recording.year,
          durationMs: recording.durationMs,
        })),
      },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Song search is unavailable right now." },
      { status: 503 },
    );
  }
}
