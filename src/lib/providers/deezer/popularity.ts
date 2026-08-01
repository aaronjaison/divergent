import { TTL } from "@/lib/cache/cachedFetch";
import {
  type AlbumRef,
  type ArtistRef,
  type PopularityProvider,
  sourced,
  type Sourced,
  type TrackRef,
} from "@/lib/providers/types";
import { normalizeArtistName, normalizeIsrc, stringSimilarity } from "@/lib/text";
import {
  dataArray,
  DEEZER_LICENSE,
  DEEZER_PROVIDER,
  dzFetch,
  idOf,
  isRecord,
  num,
  secondsToMs,
  str,
  yearFromReleaseDate,
} from "./client";

/**
 * Deezer as a popularity source: `rank` per track and `nb_fan` per artist.
 *
 * LICENSING — everything this file produces is 'noncommercial', with no
 * exceptions. Deezer's API terms permit non-commercial use only, and their
 * developer registration has been closed for years, so there is no path to a
 * commercial agreement from here. This provider exists for the dev phase only:
 * every row derived from it must stay purgeable, which is why every return
 * value below is stamped DEEZER_LICENSE and never anything softer. Before the
 * app monetises, scripts/purge-noncommercial.ts deletes all of it and the
 * signal has to be re-sourced from a licensed provider.
 */

/** Below this, a search hit is a different artist rather than a spelling variant. */
export const ARTIST_MATCH_THRESHOLD = 0.85;
export const ALBUM_MATCH_THRESHOLD = 0.85;

/** Enough hits to see past a tribute act without paying for a long response. */
const ARTIST_SEARCH_LIMIT = 5;
/** Deezer caps /artist/{id}/top at 100 whatever is asked for. */
const TOP_TRACKS_MAX = 100;
/** Deezer's albums list is unpaginated in practice at this size (45 for Radiohead). */
const ARTIST_ALBUMS_LIMIT = 100;
const ALBUM_TRACKS_LIMIT = 100;

// --- Pure mapping --------------------------------------------------------

export interface DeezerArtistHit {
  id: string;
  name: string;
  nbFan?: number;
  nbAlbum?: number;
}

export function mapArtistHit(row: unknown): DeezerArtistHit | null {
  if (!isRecord(row)) return null;
  const id = idOf(row.id);
  const name = str(row.name);
  if (!id || !name) return null;
  return { id, name, nbFan: num(row.nb_fan), nbAlbum: num(row.nb_album) };
}

/**
 * Names that normalise to nothing — CJK, Cyrillic, anything outside [a-z0-9] —
 * would score 0 against every candidate and never resolve, so they fall back to
 * a raw comparison.
 */
export function artistMatchScore(query: string, candidate: string): number {
  const left = normalizeArtistName(query);
  const right = normalizeArtistName(candidate);
  if (!left || !right) {
    return query.trim().toLowerCase() === candidate.trim().toLowerCase() ? 1 : 0;
  }
  return stringSimilarity(left, right);
}

/** Best hit at or above the threshold, ties broken by Deezer's own relevance order. */
export function pickArtistMatch(payload: unknown, name: string): DeezerArtistHit | null {
  let best: DeezerArtistHit | null = null;
  let bestScore = 0;

  for (const row of dataArray(payload)) {
    const hit = mapArtistHit(row);
    if (!hit) continue;
    const score = artistMatchScore(name, hit.name);
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }

  return bestScore >= ARTIST_MATCH_THRESHOLD ? best : null;
}

const RECORD_TYPE_TO_PRIMARY: Record<string, string> = {
  album: "Album",
  ep: "EP",
  single: "Single",
  compile: "Album",
};

export function mapAlbum(row: unknown): AlbumRef | null {
  if (!isRecord(row)) return null;
  const externalId = idOf(row.id);
  const title = str(row.title);
  if (!externalId || !title) return null;

  const recordType = str(row.record_type)?.toLowerCase();
  return {
    externalId,
    title,
    year: yearFromReleaseDate(row.release_date),
    primaryType: recordType ? RECORD_TYPE_TO_PRIMARY[recordType] : undefined,
    secondaryTypes: recordType === "compile" ? ["Compilation"] : undefined,
  };
}

/**
 * `recordTypes` filters on Deezer's raw record_type rather than the mapped
 * primaryType, because "compile" and "album" both map to Album and callers
 * asking for albums do not want compilations.
 */
export function mapAlbums(payload: unknown, recordTypes?: readonly string[]): AlbumRef[] {
  return dataArray(payload)
    .filter(isRecord)
    .filter(
      (row) => !recordTypes || recordTypes.includes(str(row.record_type)?.toLowerCase() ?? ""),
    )
    .map(mapAlbum)
    .filter((album): album is AlbumRef => album !== null);
}

export function pickAlbumMatch(albums: AlbumRef[], title: string): AlbumRef | null {
  let best: AlbumRef | null = null;
  let bestScore = 0;

  for (const album of albums) {
    const score = stringSimilarity(title, album.title);
    if (score > bestScore) {
      best = album;
      bestScore = score;
    }
  }

  return bestScore >= ALBUM_MATCH_THRESHOLD ? best : null;
}

export interface TrackContext {
  album?: string;
  albumMbid?: string;
  year?: number;
  artistNames?: string[];
}

/**
 * Accepts both /album/{id}/tracks and the `tracks` object embedded in
 * /album/{id}, which carry the same rows under different envelopes.
 */
export function albumTrackRows(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  return dataArray(payload.tracks);
}

/** `contributors` carries features; the trimmed `artist` object is the fallback. */
function trackArtistNames(row: Record<string, unknown>, context: TrackContext): string[] {
  const contributors = Array.isArray(row.contributors) ? row.contributors : [];
  const names = contributors
    .filter(isRecord)
    .map((contributor) => str(contributor.name))
    .filter((name): name is string => name !== undefined);
  if (names.length) return names;

  const single = isRecord(row.artist) ? str(row.artist.name) : undefined;
  if (single) return [single];
  return context.artistNames ?? [];
}

export function mapTrack(row: unknown, context: TrackContext = {}): TrackRef | null {
  if (!isRecord(row)) return null;
  const externalId = idOf(row.id);
  const title = str(row.title);
  if (!externalId || !title) return null;

  const album = isRecord(row.album) ? row.album : undefined;
  return {
    externalId,
    title,
    artistNames: trackArtistNames(row, context),
    album: context.album ?? (album ? str(album.title) : undefined),
    albumMbid: context.albumMbid,
    isrc: normalizeIsrc(str(row.isrc)),
    durationMs: secondsToMs(row.duration),
    year: context.year,
    rank: num(row.rank),
  };
}

export function mapTracks(payload: unknown, context: TrackContext = {}): TrackRef[] {
  return albumTrackRows(payload)
    .map((row) => mapTrack(row, context))
    .filter((track): track is TrackRef => track !== null);
}

// --- Network -------------------------------------------------------------

async function findArtistByName(name: string): Promise<DeezerArtistHit | null> {
  const query = str(name);
  if (!query) return null;
  const payload = await dzFetch(
    "/search/artist",
    { q: query, limit: ARTIST_SEARCH_LIMIT },
    TTL.catalog,
  );
  return pickArtistMatch(payload, query);
}

/** Shared with ./similarity.ts, which needs the id but not the ArtistRef wrapper. */
export async function resolveArtistId(artist: ArtistRef): Promise<string | null> {
  if (artist.externalId) return artist.externalId;
  const hit = await findArtistByName(artist.name);
  return hit?.id ?? null;
}

function fetchArtistAlbums(artistId: string): Promise<unknown> {
  return dzFetch(
    `/artist/${encodeURIComponent(artistId)}/albums`,
    { limit: ARTIST_ALBUMS_LIMIT },
    TTL.catalog,
  );
}

async function resolveAlbumId(album: AlbumRef, artist: ArtistRef): Promise<string | null> {
  const artistId = await resolveArtistId(artist);
  if (!artistId) return null;
  // Unfiltered: a caller may legitimately want the tracks of an EP or single.
  const match = pickAlbumMatch(mapAlbums(await fetchArtistAlbums(artistId)), album.title);
  return match?.externalId ?? null;
}

export const deezerPopularity: PopularityProvider = {
  id: DEEZER_PROVIDER,

  async resolveArtist(artist: ArtistRef): Promise<Sourced<ArtistRef> | null> {
    if (artist.externalId) return sourced(artist, DEEZER_PROVIDER, DEEZER_LICENSE);

    const hit = await findArtistByName(artist.name);
    if (!hit) return null;

    // Deezer's spelling wins so later title/name matching against Deezer
    // payloads is self-consistent; the mbid spine is carried through untouched.
    return sourced(
      { mbid: artist.mbid, name: hit.name, externalId: hit.id },
      DEEZER_PROVIDER,
      DEEZER_LICENSE,
    );
  },

  async getArtistTopTracks(
    artist: ArtistRef,
    limit = 50,
  ): Promise<Sourced<TrackRef[]> | null> {
    const artistId = await resolveArtistId(artist);
    if (!artistId) return null;

    const payload = await dzFetch(
      `/artist/${encodeURIComponent(artistId)}/top`,
      { limit: Math.min(Math.max(1, limit), TOP_TRACKS_MAX) },
      TTL.popularity,
    );
    if (payload === null) return null;

    // Deezer's own ordering is the popularity ordering and is deliberately not
    // re-sorted: the `rank` values it returns are not monotonically decreasing.
    // `readable` is left alone too — it reflects this server's region, and
    // playlists are exported to other services, not played on Deezer.
    return sourced(
      mapTracks(payload, { artistNames: [artist.name] }),
      DEEZER_PROVIDER,
      DEEZER_LICENSE,
    );
  },

  async getArtistAlbums(artist: ArtistRef): Promise<Sourced<AlbumRef[]>> {
    const artistId = await resolveArtistId(artist);
    if (!artistId) return sourced([], DEEZER_PROVIDER, DEEZER_LICENSE);

    const payload = await fetchArtistAlbums(artistId);
    return sourced(mapAlbums(payload, ["album"]), DEEZER_PROVIDER, DEEZER_LICENSE);
  },

  async getAlbumTracksRanked(
    album: AlbumRef,
    artist: ArtistRef,
  ): Promise<Sourced<TrackRef[]> | null> {
    const albumId = album.externalId ?? (await resolveAlbumId(album, artist));
    if (!albumId) return null;

    // /album/{id}/tracks rather than /album/{id}: the tracks embedded in the
    // latter are silently capped at 25 with no pagination and carry no ISRC,
    // which would quietly truncate the deep-cut pool for any long release.
    const payload = await dzFetch(
      `/album/${encodeURIComponent(albumId)}/tracks`,
      { limit: ALBUM_TRACKS_LIMIT },
      TTL.popularity,
    );
    if (payload === null) return null;

    return sourced(
      mapTracks(payload, {
        album: album.title,
        albumMbid: album.mbid,
        year: album.year,
        artistNames: [artist.name],
      }),
      DEEZER_PROVIDER,
      DEEZER_LICENSE,
    );
  },

  async getArtistPopularity(artist: ArtistRef): Promise<Sourced<number> | null> {
    // A search hit already carries nb_fan, so only a pre-resolved id is worth
    // an /artist/{id} round-trip.
    const hit = artist.externalId
      ? mapArtistHit(
          await dzFetch(
            `/artist/${encodeURIComponent(artist.externalId)}`,
            {},
            TTL.popularity,
          ),
        )
      : await findArtistByName(artist.name);

    if (hit?.nbFan === undefined) return null;
    return sourced(hit.nbFan, DEEZER_PROVIDER, DEEZER_LICENSE);
  },
};
