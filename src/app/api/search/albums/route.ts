import { NextResponse } from "next/server";
import { catalog } from "@/lib/providers/registry";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({ albums: [] });
  }

  try {
    const result = await catalog.searchReleaseGroups(query, 8);
    return NextResponse.json(
      {
        albums: result.data.map((album) => ({
          mbid: album.mbid,
          title: album.title,
          artistNames: album.artistNames,
          artistMbid: album.artistMbid,
          year: album.year,
          primaryType: album.primaryType,
        })),
      },
      { headers: { "Cache-Control": "private, max-age=300" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Album search is unavailable right now." },
      { status: 503 },
    );
  }
}
