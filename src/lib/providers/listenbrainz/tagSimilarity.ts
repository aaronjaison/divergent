import { TTL } from "@/lib/cache/cachedFetch";
import type { Sourced, TagProvider } from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import {
  asRecord,
  labsFetch,
  labsTagLicense,
  LB_LABS_ID,
  normaliseScore,
  readNumber,
  readString,
  scoreDivisor,
} from "./client";

export interface ScoredTag {
  tag: string;
  score: number;
}

/**
 * The score field is `count`, not `score`, and carries the same unbounded
 * per-tag scale as similar-artists (shoegaze peaks at 1388, rock at 25506).
 */
export function mapSimilarTags(
  raw: unknown,
  seedTag: string,
  limit: number,
): ScoredTag[] {
  if (!Array.isArray(raw)) return [];

  const seed = seedTag.trim().toLowerCase();
  const rows: { tag: string; raw: number }[] = [];

  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;

    const tag = readString(row.similar_tag)?.toLowerCase();
    const count = readNumber(row.count);
    if (!tag || count === undefined || tag === seed) continue;

    rows.push({ tag, raw: count });
  }

  const divisor = scoreDivisor(rows.map((row) => row.raw));

  return rows
    .map((row) => ({ tag: row.tag, score: normaliseScore(row.raw, divisor) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

export const listenBrainzTags: Pick<TagProvider, "id" | "getSimilarTags"> = {
  id: LB_LABS_ID,

  async getSimilarTags(
    tag: string,
    limit = 50,
  ): Promise<Sourced<ScoredTag[]>> {
    // Matching is literal: "Shoegaze" and "SHOEGAZE" both return []. Note that
    // "trip hop" and "trip-hop" are *separate* tags with disjoint results, so
    // callers holding both spellings must ask twice.
    const seed = tag.trim().toLowerCase();
    if (!seed) return sourced<ScoredTag[]>([], LB_LABS_ID, labsTagLicense());

    const raw = await labsFetch("tag-similarity", { tag: seed }, TTL.tags);

    return sourced(mapSimilarTags(raw, seed, limit), LB_LABS_ID, labsTagLicense());
  },
};
