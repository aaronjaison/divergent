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

/**
 * An album a listener picked as a seed, carrying everything needed to profile
 * it without a second lookup.
 *
 * A release-group search returns the album's whole tag list inline, and those
 * tags are more specific than the artist's: Radiohead as an artist is
 * "alternative rock", but "Kid A" is tagged electronic and experimental while
 * "The Bends" is not. Seeding from a record therefore says something an artist
 * name cannot.
 */
export interface ScoredAlbumRef extends AlbumRef {
  score: number;
  artistNames: string[];
  /** Primary credited artist, when MusicBrainz gave one. */
  artistMbid?: string;
  disambiguation?: string;
  tags?: Record<string, number>;
}

/**
 * A song a listener picked as a seed.
 *
 * `mbids` is a list rather than a single id on purpose. MusicBrainz holds one
 * recording per distinct performance, so a hit single exists a dozen times over
 * — the single, the album cut, the compilation appearance, the video — and only
 * some of those ids carry listening data. Keeping every candidate is what lets
 * the similarity lookup try again instead of reporting that a famous song has
 * no neighbours; ordered best-first, so the first is the one to display.
 */
export interface ScoredRecordingRef {
  mbids: string[];
  title: string;
  artistNames: string[];
  artistMbid?: string;
  album?: string;
  /** Release-GROUP mbid, not a release: the album, not one of its pressings. */
  albumMbid?: string;
  year?: number;
  durationMs?: number;
  isrc?: string;
  /** The recording's own tags — sparse, but the sharpest signal there is. */
  tags?: Record<string, number>;
  score: number;
}

/** One neighbour of a seed recording, as co-listening sees it. */
export interface SimilarRecording {
  recordingMbid: string;
  recordingName: string;
  artistNames: string[];
  /** Every artist credited on the neighbour, so no second lookup is needed. */
  artistMbids: string[];
  /** 0-1, normalised within the response. */
  score: number;
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
  /** Songs matching free text, for picking playlist seeds. */
  searchRecordings(query: string, limit?: number): Promise<Sourced<ScoredRecordingRef[]>>;
  /** Albums matching free text, for picking playlist seeds. */
  searchReleaseGroups(query: string, limit?: number): Promise<Sourced<ScoredAlbumRef[]>>;
  /**
   * Genre profiles for many artists at once, keyed by MBID.
   *
   * Optional, and worth having because judging whether a candidate fits the
   * rest of a playlist needs every candidate's profile, not the handful an
   * artist-at-a-time lookup can afford at one request per second.
   */
  getTagProfiles?(mbids: readonly string[]): Promise<Sourced<Map<string, Record<string, number>>>>;
  /** The same trick for albums, keyed by release-group MBID. */
  getReleaseGroupProfiles?(
    mbids: readonly string[],
  ): Promise<Sourced<Map<string, Record<string, number>>>>;
  /**
   * And for individual songs, keyed by recording MBID. Sparse — most recordings
   * carry no tags at all — but a song that has them describes itself better
   * than its artist ever could.
   */
  getRecordingProfiles?(
    mbids: readonly string[],
  ): Promise<Sourced<Map<string, Record<string, number>>>>;
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
  /**
   * Neighbours of one specific recording — the only signal that can tell
   * "songs like this song" from "songs by artists like this artist". Optional,
   * because only a session-based source has it at all.
   *
   * Callers pass every candidate MBID for the song: coverage is per-recording,
   * so the album cut may be known to the index while the single is not.
   */
  getSimilarRecordings?(
    recordingMbids: readonly string[],
    limit?: number,
  ): Promise<Sourced<SimilarRecording[]>>;
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
