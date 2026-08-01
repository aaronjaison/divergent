import { NextResponse } from "next/server";
import { searchTags } from "@/lib/db/repo/tags";

/**
 * Tag search is local-only: the genre vocabulary is seeded once by
 * scripts/seed-genres.ts, so autocomplete costs nothing and stays instant even
 * though every other lookup in the app is rate-limited.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({ tags: [] });
  }

  const tags = searchTags(query, 12).map((tag) => ({
    name: tag.name,
    kind: tag.kind,
  }));

  return NextResponse.json(
    { tags },
    { headers: { "Cache-Control": "private, max-age=600" } },
  );
}
