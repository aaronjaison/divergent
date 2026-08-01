import { NextResponse } from "next/server";
import { catalog } from "@/lib/providers/registry";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({ artists: [] });
  }

  try {
    const result = await catalog.searchArtists(query, 8);
    return NextResponse.json(
      {
        artists: result.data.map((artist) => ({
          mbid: artist.mbid,
          name: artist.name,
          disambiguation: artist.disambiguation,
          country: artist.country,
          beginYear: artist.beginYear,
          endYear: artist.endYear,
        })),
      },
      // Repeated searches are common and results barely change.
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Artist search is unavailable right now." },
      { status: 503 },
    );
  }
}
