import { config } from "@/lib/config";
import { deezerPopularity } from "./deezer/popularity";
import { deezerSimilarity } from "./deezer/similarity";
import { listenBrainzIds } from "./listenbrainz/idResolution";
import { listenBrainzSimilarity } from "./listenbrainz/similarity";
import { listenBrainzTags } from "./listenbrainz/tagSimilarity";
import { musicbrainzCatalog } from "./musicbrainz/catalog";
import { musicbrainzTags } from "./musicbrainz/tags";
import type {
  CatalogProvider,
  IdResolutionProvider,
  PopularityProvider,
  SimilarityProvider,
  TagProvider,
} from "./types";

/**
 * Provider wiring.
 *
 * Every provider is reached through this module, so swapping one is a change
 * here rather than across the codebase. That matters most for popularity:
 * Deezer supplies it today under non-commercial terms, and a licensed
 * Soundcharts implementation drops into the same slot at commercial launch.
 */

export const catalog: CatalogProvider = musicbrainzCatalog;

export const tags: TagProvider = {
  id: musicbrainzTags.id,
  getArtistsForTag: musicbrainzTags.getArtistsForTag,
  // MusicBrainz has no notion of related tags; ListenBrainz does, and it
  // deliberately excludes megatags, which is what keeps a "trip hop" request
  // from widening into "electronic".
  getSimilarTags: listenBrainzTags.getSimilarTags,
};

/**
 * Similarity sources in preference order. ListenBrainz is first because its
 * signal is session-based co-listening (CC0, commercially clean); Deezer is a
 * positional fallback for artists ListenBrainz has never seen.
 */
export const similarityProviders: SimilarityProvider[] = [
  listenBrainzSimilarity,
  ...(config.providers.deezerEnabled ? [deezerSimilarity] : []),
];

export const popularity: PopularityProvider | null = config.providers
  .deezerEnabled
  ? deezerPopularity
  : null;

export const idResolution: IdResolutionProvider = listenBrainzIds;

/** True when a popularity source exists; "famous" and "deep cuts" need one. */
export function hasPopularitySource(): boolean {
  return popularity !== null;
}
