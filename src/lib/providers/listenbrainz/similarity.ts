import { TTL } from "@/lib/cache/cachedFetch";
import type {
  ArtistRef,
  ScoredArtistRef,
  SimilarityProvider,
  Sourced,
} from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import {
  asRecord,
  isMbid,
  labsFetch,
  LB_LABS_ID,
  LB_LABS_LICENSE,
  normaliseScore,
  readNumber,
  readString,
  scoreDivisor,
  SIMILAR_ARTISTS_ALGORITHM,
} from "./client";

interface ParsedRow {
  mbid: string;
  name: string;
  disambiguation?: string;
  raw: number;
}

/**
 * `country`/`beginYear`/`endYear` stay undefined: this endpoint returns `type`
 * and `gender` instead, neither of which maps onto ScoredArtistRef.
 */
export function mapSimilarArtists(
  raw: unknown,
  seedMbid: string,
  limit: number,
): ScoredArtistRef[] {
  if (!Array.isArray(raw)) return [];

  const seed = seedMbid.trim().toLowerCase();
  const rows: ParsedRow[] = [];

  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;

    const mbid = readString(row.artist_mbid)?.toLowerCase();
    const name = readString(row.name);
    const score = readNumber(row.score);
    if (!mbid || !name || score === undefined) continue;

    // The seed appears inside its own neighbour list, and not necessarily near
    // the top — Duster sits at #68 of its own 100 — so dropping the first row
    // does not catch it. Those rows are the ones with reference_mbid: null.
    if (mbid === seed) continue;

    rows.push({
      mbid,
      name,
      disambiguation: readString(row.comment),
      raw: score,
    });
  }

  const divisor = scoreDivisor(rows.map((row) => row.raw));

  return rows
    .map((row) => ({
      mbid: row.mbid,
      name: row.name,
      disambiguation: row.disambiguation,
      score: normaliseScore(row.raw, divisor),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

export const listenBrainzSimilarity: SimilarityProvider = {
  id: LB_LABS_ID,

  async getSimilarArtists(
    artist: ArtistRef,
    limit = 50,
  ): Promise<Sourced<ScoredArtistRef[]>> {
    const mbid = artist.mbid?.trim().toLowerCase();
    // MBID-only endpoint. An unresolved, name-only artist is a normal input
    // from upstream, so it costs nothing rather than throwing; a malformed one
    // stops here too, because labs answers that with a 400 rather than `[]`.
    if (!mbid || !isMbid(mbid)) {
      return sourced<ScoredArtistRef[]>([], LB_LABS_ID, LB_LABS_LICENSE);
    }

    const raw = await labsFetch(
      "similar-artists",
      { artist_mbids: mbid, algorithm: SIMILAR_ARTISTS_ALGORITHM },
      TTL.similarity,
    );

    return sourced(
      mapSimilarArtists(raw, mbid, limit),
      LB_LABS_ID,
      LB_LABS_LICENSE,
    );
  },
};
