import { TTL } from "@/lib/cache/cachedFetch";
import {
  type ArtistRef,
  type ScoredArtistRef,
  type SimilarityProvider,
  sourced,
  type Sourced,
} from "@/lib/providers/types";
import {
  dataArray,
  DEEZER_LICENSE,
  DEEZER_PROVIDER,
  dzFetch,
  idOf,
  isRecord,
  str,
} from "./client";
import { resolveArtistId } from "./popularity";

/**
 * Fallback similar-artist source, used when Last.fm / ListenBrainz have nothing.
 *
 * Same licensing constraint as ./popularity.ts: Deezer's terms are strictly
 * non-commercial, so every row here is stamped 'noncommercial' and must be
 * purgeable before the app monetises.
 */

const RELATED_LIMIT = 20;

/**
 * Deezer publishes no similarity number, only an ordering — and that ordering
 * is genuinely similarity-based rather than popularity-based (Arctic Monkeys at
 * 4.9M fans sits below Jeff Buckley at 322k for Radiohead), so it must not be
 * re-sorted. The score below is purely positional: comparable within one
 * response, meaningless against another provider's scores.
 */
export function mapSimilarArtists(payload: unknown, limit: number): ScoredArtistRef[] {
  // Unusable rows are dropped *before* the position score is taken: scoring by
  // raw index would let one nameless row push every real neighbour down a rank,
  // and the engine spends its track budget in proportion to these scores.
  const usable = dataArray(payload)
    .filter(isRecord)
    .map((row) => ({ name: str(row.name), externalId: idOf(row.id) }))
    .filter(
      (row): row is { name: string; externalId: string | undefined } =>
        row.name !== undefined,
    )
    .slice(0, Math.max(0, limit));

  const total = usable.length;
  return usable.map((row, index) => ({ ...row, score: (total - index) / total }));
}

export const deezerSimilarity: SimilarityProvider = {
  id: DEEZER_PROVIDER,

  async getSimilarArtists(
    artist: ArtistRef,
    limit = RELATED_LIMIT,
  ): Promise<Sourced<ScoredArtistRef[]>> {
    const artistId = await resolveArtistId(artist);
    if (!artistId) return sourced([], DEEZER_PROVIDER, DEEZER_LICENSE);

    const payload = await dzFetch(
      `/artist/${encodeURIComponent(artistId)}/related`,
      { limit },
      TTL.similarity,
    );
    if (payload === null) return sourced([], DEEZER_PROVIDER, DEEZER_LICENSE);

    return sourced(mapSimilarArtists(payload, limit), DEEZER_PROVIDER, DEEZER_LICENSE);
  },
};
