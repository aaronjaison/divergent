import { NextResponse } from "next/server";
import { lookupLinks, PLATFORM_LABELS } from "@/lib/export/songlink";

/**
 * Resolves one track to its equivalents on other services.
 *
 * Called only when a user clicks a specific track: Odesli allows roughly 10
 * requests per minute per IP, so resolving a whole playlist eagerly would take
 * minutes and exhaust the budget for every other visitor.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const isrc = params.get("isrc");

  if (!isrc) {
    return NextResponse.json(
      { error: "This track has no ISRC, so it cannot be matched across services." },
      { status: 400 },
    );
  }

  try {
    const result = await lookupLinks({ isrc });
    if (!result) {
      return NextResponse.json({ links: [], pageUrl: null });
    }

    return NextResponse.json({
      pageUrl: result.pageUrl ?? null,
      links: Object.entries(result.links).map(([platform, url]) => ({
        platform,
        label: PLATFORM_LABELS[platform] ?? platform,
        url,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Link lookup is busy right now. Try again in a moment." },
      { status: 503 },
    );
  }
}
