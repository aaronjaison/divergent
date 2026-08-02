import type { LicenseClass, ProviderId } from "@/lib/db/schema";

/**
 * Every provider result is wrapped with where it came from and under what
 * licence. Nothing downstream is allowed to lose that: the generation engine
 * never learns which source fed it, and the purge script relies entirely on
 * these fields to clear non-commercial data before a commercial launch.
 */
export interface Sourced<T> {
  data: T;
  source: ProviderId;
  licenseClass: LicenseClass;
  fetchedAt: number;
}

export function sourced<T>(
  data: T,
  source: ProviderId,
  licenseClass: LicenseClass,
  fetchedAt = Date.now(),
): Sourced<T> {
  return { data, source, licenseClass, fetchedAt };
}

// --- Shared reference shapes --------------------------------------------

export interface ArtistRef {
  mbid?: string;
  name: string;
  /** Provider-native id, e.g. a Deezer artist id. */
  externalId?: string;
}

export interface ScoredArtistRef extends ArtistRef {
  /** 0-1. Similarity or tag-affinity depending on context. */
  score: number;
  disambiguation?: string;
  country?: string;
  beginYear?: number;
  endYear?: number;
  /**
   * The artist's own genre profile, tag -> 0-1, when the provider supplied one.
   * Absent means unknown, which the engine treats as neutral rather than as a
   * mismatch — tag coverage thins out fast below the famous, and scoring a
   * missing profile as "does not belong" would exclude the smaller artists
   * this app exists to surface.
   */
  tags?: Record<string, number>;
}

export interface AlbumRef {
  mbid?: string;
  externalId?: string;
  title: string;
  year?: number;
  primaryType?: string;
  secondaryTypes?: string[];
}

export interface TrackRef {
  mbid?: string;
  externalId?: string;
  title: string;
  artistNames: string[];
  album?: string;
  albumMbid?: string;
  isrc?: string;
  durationMs?: number;
  year?: number;
  /**
   * Provider-native popularity, higher = more popular. Deezer's `rank` and
   * Last.fm playcounts both land here; scale is only meaningful within a source.
   */
  rank?: number;
}

export interface ArtistDetail {
  mbid: string;
  name: string;
  sortName?: string;
  disambiguation?: string;
  country?: string;
  beginYear?: number;
  endYear?: number;
  /** name -> 0-1 weight, normalised within this artist. */
  tags: Record<string, number>;
}

// --- Provider contracts --------------------------------------------------

export interface CatalogProvider {
  readonly id: ProviderId;
  searchArtists(query: string, limit?: number): Promise<Sourced<ScoredArtistRef[]>>;
  getArtist(mbid: string): Promise<Sourced<ArtistDetail> | null>;
  getArtistAlbums(mbid: string): Promise<Sourced<AlbumRef[]>>;
  getAlbumTracks(album: AlbumRef): Promise<Sourced<TrackRef[]>>;
  /**
   * Genre profiles for many artists at once, keyed by MBID.
   *
   * Optional, and worth having because judging whether a candidate fits the
   * rest of a playlist needs every candidate's profile, not the handful an
   * artist-at-a-time lookup can afford at one request per second.
   */
  getTagProfiles?(mbids: readonly string[]): Promise<Sourced<Map<string, Record<string, number>>>>;
}

export interface TagProvider {
  readonly id: ProviderId;
  /** Artists strongly associated with a tag, best first. */
  getArtistsForTag(tag: string, limit?: number): Promise<Sourced<ScoredArtistRef[]>>;
  /**
   * Neighbouring tags for expanding a thin seed. Implementations should avoid
   * returning megatags ("rock", "pop") which collapse a specific request.
   */
  getSimilarTags(tag: string, limit?: number): Promise<Sourced<{ tag: string; score: number }[]>>;
}

export interface SimilarityProvider {
  readonly id: ProviderId;
  getSimilarArtists(artist: ArtistRef, limit?: number): Promise<Sourced<ScoredArtistRef[]>>;
}

export interface PopularityProvider {
  readonly id: ProviderId;
  /** The artist's best-known tracks, most popular first. */
  getArtistTopTracks(artist: ArtistRef, limit?: number): Promise<Sourced<TrackRef[]> | null>;
  /**
   * Every track on an album with its popularity rank — the cheap deep-cut
   * signal: one call yields the whole album's distribution.
   */
  getAlbumTracksRanked(album: AlbumRef, artist: ArtistRef): Promise<Sourced<TrackRef[]> | null>;
  getArtistAlbums?(artist: ArtistRef): Promise<Sourced<AlbumRef[]>>;
  getArtistPopularity(artist: ArtistRef): Promise<Sourced<number> | null>;
  /** Resolves an artist to this provider's own id, so later calls can skip the search. */
  resolveArtist(artist: ArtistRef): Promise<Sourced<ArtistRef> | null>;
}

export interface IdResolutionProvider {
  readonly id: ProviderId;
  idFromMbid(
    recordingMbid: string,
    target: "spotify" | "apple",
  ): Promise<Sourced<string | null>>;
}
