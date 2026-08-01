import {
  isExcludedAlbumTitle,
  isExcludedReleaseType,
} from "@/lib/engine/titleFilters";
import type { EngineTrack, MatchConfidence } from "@/lib/engine/types";
import { normalizeIsrc, normalizeTitle } from "@/lib/text";
import type { AlbumRef, ArtistRef, TrackRef } from "@/lib/providers/types";
import { catalog, popularity } from "@/lib/providers/registry";

/**
 * Turns provider results into the engine's track shape.
 *
 * The engine deliberately knows nothing about providers, so this is where
 * cross-source reconciliation happens: popularity is normalised to a common
 * 0-100 scale and match confidence is recorded so the engine can refuse fuzzy
 * matches where a wrong track would go unnoticed.
 */

export function toEngineTrack(
  track: TrackRef,
  artistKey: string,
  confidence: MatchConfidence,
  popularityScore?: number,
): EngineTrack {
  const titleNorm = normalizeTitle(track.title);
  return {
    // Prefer the MBID: it is the only globally stable identity available.
    key: track.mbid ?? `${artistKey}:${titleNorm}`,
    title: track.title,
    titleNorm,
    artistKey,
    artistNames: track.artistNames.length ? track.artistNames : [artistKey],
    album: track.album,
    albumKey: track.albumMbid ?? track.album,
    year: track.year,
    durationMs: track.durationMs,
    isrc: normalizeIsrc(track.isrc),
    recordingMbid: track.mbid,
    popularity: popularityScore,
    matchConfidence: confidence,
  };
}

/**
 * Maps provider-native ranks onto 0-100 within the supplied set.
 *
 * Deezer's `rank` runs to roughly a million and its absolute value is
 * meaningless across artists, so only the ordering is preserved. Tracks
 * without a rank stay undefined rather than becoming zero — the engine treats
 * unknown popularity differently from low popularity, and collapsing the two
 * would let unranked tracks masquerade as deep cuts.
 */
export function normalizeRanks(tracks: readonly TrackRef[]): (number | undefined)[] {
  const ranks = tracks.map((track) => track.rank);
  const known = ranks.filter((rank): rank is number => rank !== undefined);
  if (known.length === 0) return ranks.map(() => undefined);

  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = max - min;

  return ranks.map((rank) => {
    if (rank === undefined) return undefined;
    // A single distinct value carries no information about relative fame.
    if (span === 0) return 50;
    return ((rank - min) / span) * 100;
  });
}

export interface ArtistTrackPool {
  tracks: EngineTrack[];
  /** True when a popularity provider matched this artist. */
  ranked: boolean;
}

/**
 * The artist's best-known tracks. Used directly by "the essentials" and as the
 * exclusion list for deep cuts.
 */
export async function loadTopTracks(
  artist: ArtistRef,
  artistKey: string,
  limit = 50,
): Promise<ArtistTrackPool> {
  if (!popularity) return { tracks: [], ranked: false };

  const result = await popularity.getArtistTopTracks(artist, limit);
  if (!result || result.data.length === 0) return { tracks: [], ranked: false };

  const scores = normalizeRanks(result.data);
  const tracks = result.data.map((track, index) =>
    // Name-matched against the provider's catalogue, so not ISRC-exact.
    toEngineTrack(track, artistKey, track.isrc ? "isrc" : "exact", scores[index]),
  );

  return { tracks, ranked: true };
}

/**
 * Album tracks with per-track popularity — the deep-cut signal. One call per
 * album yields the whole record's distribution, which is far cheaper than
 * looking up each track individually.
 */
export async function loadAlbumTracks(
  artist: ArtistRef,
  artistKey: string,
  options: { maxAlbums?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<ArtistTrackPool> {
  const { maxAlbums = 12, onProgress } = options;
  if (!popularity?.getArtistAlbums) return { tracks: [], ranked: false };

  const albumsResult = await popularity.getArtistAlbums(artist);
  const albums = dedupeAlbums(
    albumsResult.data.filter(
      (album) =>
        !isExcludedAlbumTitle(album.title) &&
        !isExcludedReleaseType(album.secondaryTypes),
    ),
  ).slice(0, maxAlbums);
  if (albums.length === 0) return { tracks: [], ranked: false };

  const tracks: EngineTrack[] = [];
  let ranked = false;

  for (const [index, album] of albums.entries()) {
    onProgress?.(index, albums.length);

    const result = await popularity.getAlbumTracksRanked(album, artist);
    if (!result || result.data.length === 0) continue;

    // Ranks are normalised per album, not per catalogue: a quiet album's
    // strongest track is still a deep cut, and a famous album's filler is too.
    const scores = normalizeRanks(result.data);
    ranked = true;

    result.data.forEach((track, i) => {
      tracks.push(
        toEngineTrack(
          { ...track, album: track.album ?? album.title, year: track.year ?? album.year },
          artistKey,
          track.isrc ? "isrc" : "exact",
          scores[i],
        ),
      );
    });
  }

  onProgress?.(albums.length, albums.length);
  return { tracks, ranked };
}

/**
 * Fallback when no popularity provider matched: MusicBrainz alone. The tracks
 * are real but carry no popularity, so the engine will only place them in the
 * medium band.
 */
export async function loadCatalogTracks(
  artistMbid: string,
  artistKey: string,
  maxAlbums = 6,
): Promise<ArtistTrackPool> {
  const albums = await catalog.getArtistAlbums(artistMbid);
  const tracks: EngineTrack[] = [];
  const usable = dedupeAlbums(
    albums.data.filter(
      (album) =>
        !isExcludedAlbumTitle(album.title) &&
        !isExcludedReleaseType(album.secondaryTypes),
    ),
  );

  for (const album of usable.slice(0, maxAlbums)) {
    const result = await catalog.getAlbumTracks(album);
    for (const track of result.data) {
      tracks.push(
        toEngineTrack(
          { ...track, album: track.album ?? album.title, year: track.year ?? album.year },
          artistKey,
          "exact",
        ),
      );
    }
  }

  return { tracks, ranked: false };
}

/** Deduplicates album entries that differ only by reissue/edition. */
export function dedupeAlbums(albums: readonly AlbumRef[]): AlbumRef[] {
  const seen = new Set<string>();
  const out: AlbumRef[] = [];
  for (const album of albums) {
    const key = normalizeTitle(album.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(album);
  }
  return out;
}
