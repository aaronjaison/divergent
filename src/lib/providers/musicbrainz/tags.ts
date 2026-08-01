import { TTL } from "@/lib/cache/cachedFetch";
import type { ScoredArtistRef, TagProvider } from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import { mapArtist } from "./catalog";
import {
  MB_MAX_LIMIT,
  MB_PROVIDER,
  mbArtistSchema,
  mbArtistSearchSchema,
  mbFetch,
  mbGenreAllSchema,
  mbGenreSchema,
  mbTagLicense,
  parseEach,
} from "./client";

/**
 * Tag-driven discovery. MusicBrainz has no "artists by tag" endpoint, only a
 * Lucene search over the artist index, and its relevance score is close to
 * useless for this purpose — see rankArtistsForTag.
 */

/**
 * How much of the final score comes from MB's relevance rather than the
 * artist's own vote count. Small on purpose: relevance is only there to order
 * artists whose counts tie.
 */
const RELEVANCE_WEIGHT = 0.1;

/** ~2181 genres at 100 per page; the cap is slack, not a real expectation. */
const MAX_GENRE_PAGES = 40;

/**
 * Always quoted, even for a single word: unquoted, `tag:dream pop` parses as
 * `tag:dream` plus a free-text `pop` and returns a completely different set.
 */
export function tagQuery(tag: string): string {
  return `tag:"${tag.trim().replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Re-ranks a tag search on each artist's own vote count for that tag.
 *
 * MB's `score` is Lucene relevance across the whole artist document, not tag
 * strength: `tag:shoegaze` puts Oasis (zero shoegaze votes) second, above
 * Slowdive, and `tag:"dream pop"` scores Coldplay 91 on a single vote. The
 * counts needed to fix that ride along in the same response, so the correction
 * costs no extra call.
 */
export function rankArtistsForTag(
  raws: readonly unknown[] | null | undefined,
  tag: string,
): ScoredArtistRef[] {
  const wanted = tag.trim().toLowerCase();

  const entries = parseEach(raws, mbArtistSchema).map((artist) => {
    const own = (artist.tags ?? []).find(
      (candidate) => candidate.name.trim().toLowerCase() === wanted,
    );
    return {
      ref: mapArtist(artist),
      // Search-embedded counts run to 0 and below for junk tags.
      count: Math.max(own?.count ?? 0, 0),
    };
  });

  let maxCount = 0;
  for (const entry of entries) maxCount = Math.max(maxCount, entry.count);

  const scored = entries.map((entry) => ({
    ...entry.ref,
    // With no votes anywhere in the page there is nothing to re-rank on, so
    // relevance is all that's left.
    score:
      maxCount > 0
        ? (entry.count / maxCount) * (1 - RELEVANCE_WEIGHT) +
          entry.ref.score * RELEVANCE_WEIGHT
        : entry.ref.score,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const musicbrainzTags: Pick<TagProvider, "id" | "getArtistsForTag"> = {
  id: MB_PROVIDER,

  async getArtistsForTag(tag, limit = 25) {
    const trimmed = tag.trim();
    if (!trimmed) return sourced([], MB_PROVIDER, mbTagLicense());

    // Always fetch the full page regardless of `limit`: the local re-rank is
    // only as good as the pool it sees, and a wider page costs the same call.
    const envelope = await mbFetch(
      "/artist",
      { query: tagQuery(trimmed), limit: MB_MAX_LIMIT },
      mbArtistSearchSchema,
      TTL.tags,
    );

    const ranked = rankArtistsForTag(envelope?.artists, trimmed).slice(0, limit);
    return sourced(ranked, MB_PROVIDER, mbTagLicense());
  },
};

/**
 * The full curated genre vocabulary, lowercase and alphabetical, for seeding
 * the tags table. /ws/2/genre/all works but caps at 100 per page, so this is
 * ~22 paced calls — half a minute, once, then TTL.permanent.
 *
 * These are exactly the names and MBIDs that appear in an artist lookup's
 * `genres[]`, which is what makes them usable as a whitelist for the freeform
 * `tags[]` superset.
 */
export async function fetchAllGenres(): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < MAX_GENRE_PAGES; page++) {
    const envelope = await mbFetch(
      "/genre/all",
      { limit: MB_MAX_LIMIT, offset: page * MB_MAX_LIMIT },
      mbGenreAllSchema,
      TTL.permanent,
    );

    const raw = envelope?.genres ?? [];
    for (const genre of parseEach(raw, mbGenreSchema)) {
      const name = genre.name.trim().toLowerCase();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }

    const total = envelope?.["genre-count"] ?? 0;
    if (raw.length < MB_MAX_LIMIT || (page + 1) * MB_MAX_LIMIT >= total) break;
  }

  return names;
}
