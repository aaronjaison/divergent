import { TTL } from "@/lib/cache/cachedFetch";
import type {
  AlbumRef,
  ArtistDetail,
  CatalogProvider,
  ScoredArtistRef,
  TrackRef,
} from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import { normalizeIsrc } from "@/lib/text";
import {
  MB_CORE_LICENSE,
  MB_MAX_LIMIT,
  MB_PROVIDER,
  mbArtistSchema,
  mbArtistSearchSchema,
  mbFetch,
  mbReleaseBrowseSchema,
  mbReleaseGroupBrowseSchema,
  mbReleaseGroupSchema,
  mbReleaseSchema,
  mbTagLicense,
  parseEach,
  type MbArtist,
  type MbRelease,
} from "./client";

/**
 * MusicBrainz as the canonical catalogue: MBIDs in, MBIDs out.
 *
 * Call count is the scarce resource here (1 req/s), so each method is shaped
 * around the cheapest request that answers the question — most notably
 * getAlbumTracks, which gets titles, durations, credits and ISRCs for a whole
 * album out of a single browse.
 */

/**
 * A name that appears only in the freeform `tags` array is worth this fraction
 * of the same vote count in the curated `genres` array. MB returns both, and
 * `genres` is in practice a strict subset of `tags` with identical counts —
 * the extra entries in `tags` are locales, labels and noise ("british",
 * "parlophone", "1992-1998"). The discount keeps genuinely useful uncurated
 * styles in play without letting them outrank a curated genre.
 */
const RAW_TAG_WEIGHT = 0.6;

/**
 * Release-group browse pages come back ordered by MBID, so a prolific artist's
 * studio albums are scattered across all of them and stopping at page one
 * silently loses albums. Capped anyway: 385 release-groups is not worth five
 * seconds of a cold generation.
 */
const MAX_ALBUM_PAGES = 5;

/** Enough pressings to choose between without paying for a long tail. */
const RELEASES_PER_ALBUM = 5;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/** Partial dates arrive as "1997-05-21", "2005-08", "1994" or "". */
export function parseYear(date: string | null | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function firstIsrc(isrcs: readonly string[] | null | undefined): string | undefined {
  for (const isrc of isrcs ?? []) {
    const normalised = normalizeIsrc(isrc);
    if (normalised) return normalised;
  }
  return undefined;
}

function countryOf(artist: MbArtist): string | undefined {
  return artist.country || artist.area?.["iso-3166-1-codes"]?.[0] || undefined;
}

export function mapArtist(artist: MbArtist): ScoredArtistRef {
  const lifeSpan = artist["life-span"];
  // Search hits carry the artist's whole tag list already, so the genre profile
  // that lets the engine judge whether a candidate fits the rest of the
  // playlist costs no extra request. Dropping it was why nothing downstream
  // could tell a drill artist from a breakbeat-pop one under the same tag.
  const tags = mergeTags(artist.genres, artist.tags);
  return {
    mbid: artist.id,
    name: artist.name,
    // MB normalises Lucene relevance so the best hit is always exactly 100.
    score: clamp01((artist.score ?? 0) / 100),
    // Empty in lookups, absent in searches; both mean "no qualifier".
    disambiguation: artist.disambiguation || undefined,
    country: countryOf(artist),
    beginYear: parseYear(lifeSpan?.begin),
    endYear: parseYear(lifeSpan?.end),
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

export function mapArtistSearchResult(raw: unknown): ScoredArtistRef | null {
  const parsed = mbArtistSchema.safeParse(raw);
  return parsed.success ? mapArtist(parsed.data) : null;
}

export interface CountedName {
  name: string;
  count?: number | null;
}

/**
 * Folds `genres` and `tags` into one 0-1 weighting, normalised by the artist's
 * own maximum so a heavily-tagged artist can't dominate tag queries.
 *
 * Counts are clamped first: search-embedded tags go negative for junk entries
 * ("england", "sacred cows"), and a zero-vote tag carries no signal at all.
 */
export function mergeTags(
  genres: readonly CountedName[] | null | undefined,
  tags: readonly CountedName[] | null | undefined,
): Record<string, number> {
  const weighted = new Map<string, number>();

  const add = (entries: readonly CountedName[] | null | undefined, weight: number): void => {
    for (const entry of entries ?? []) {
      const name = entry.name.trim().toLowerCase();
      if (!name) continue;
      const count = Math.max(entry.count ?? 0, 0);
      if (count <= 0) continue;
      const value = count * weight;
      const existing = weighted.get(name);
      // A name in both arrays keeps its curated weight.
      if (existing === undefined || value > existing) weighted.set(name, value);
    }
  };

  add(genres, 1);
  add(tags, RAW_TAG_WEIGHT);

  let max = 0;
  for (const value of weighted.values()) max = Math.max(max, value);
  if (max <= 0) return {};

  const merged: Record<string, number> = {};
  for (const [name, value] of weighted) merged[name] = value / max;
  return merged;
}

export function mapReleaseGroup(raw: unknown): AlbumRef | null {
  const parsed = mbReleaseGroupSchema.safeParse(raw);
  if (!parsed.success) return null;
  const group = parsed.data;

  return {
    mbid: group.id,
    title: group.title,
    year: parseYear(group["first-release-date"]),
    primaryType: group["primary-type"] ?? undefined,
    // Sometimes [], sometimes absent. The engine excludes Live/Compilation/
    // Soundtrack on this field, so it must always be an array.
    secondaryTypes: group["secondary-types"] ?? [],
  };
}

function trackCount(release: MbRelease): number {
  return (release.media ?? []).reduce(
    (total, medium) => total + (medium.tracks?.length ?? 0),
    0,
  );
}

/**
 * Browse order is neither chronological nor canonical — the unfiltered browse
 * for OK Computer hands back the Japanese pressing first, out of 38. Prefer an
 * official release, then the earliest dated one, so a later deluxe reissue's
 * bonus disc doesn't get mistaken for the album.
 */
export function pickBestRelease(
  raws: readonly unknown[] | null | undefined,
): MbRelease | null {
  const candidates = parseEach(raws, mbReleaseSchema).filter(
    (release) => trackCount(release) > 0,
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const officialGap = officialRank(a) - officialRank(b);
    if (officialGap !== 0) return officialGap;
    // Undated releases sort last; partial dates compare correctly as strings.
    const dateGap = (a.date || "9999").localeCompare(b.date || "9999");
    if (dateGap !== 0) return dateGap;
    return trackCount(b) - trackCount(a);
  });

  return candidates[0];
}

function officialRank(release: MbRelease): number {
  return release.status === "Official" ? 0 : 1;
}

export function mapReleaseTracks(release: MbRelease, album?: AlbumRef): TrackRef[] {
  const media = [...(release.media ?? [])].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );

  const tracks: TrackRef[] = [];
  for (const medium of media) {
    const ordered = [...(medium.tracks ?? [])].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    );

    for (const track of ordered) {
      const recording = track.recording;
      // Track-level titles override the recording's for medleys and bonus cuts.
      const title = track.title || recording?.title;
      if (!title) continue;

      const credits =
        track["artist-credit"] ??
        recording?.["artist-credit"] ??
        release["artist-credit"] ??
        [];

      tracks.push({
        // The recording MBID is the stable identity; the track id belongs to
        // this pressing and would fragment the same song across releases.
        mbid: recording?.id ?? undefined,
        title,
        artistNames: credits.map((credit) => credit.name).filter((name) => name.length > 0),
        album: album?.title ?? release.title,
        albumMbid: album?.mbid,
        isrc: firstIsrc(recording?.isrcs),
        // The two lengths disagree by up to a second; the pressing's timing is
        // the one that matches what will actually play.
        durationMs: track.length ?? recording?.length ?? undefined,
        year:
          parseYear(recording?.["first-release-date"]) ??
          parseYear(release.date) ??
          album?.year,
      });
    }
  }

  return tracks;
}

async function browseReleases(
  releaseGroupMbid: string,
  status?: string,
): Promise<unknown[]> {
  // inc=isrcs is accepted on the release browse, so this one request carries
  // titles, recording MBIDs, durations, credits and ISRCs for the whole album.
  const envelope = await mbFetch(
    "/release",
    {
      "release-group": releaseGroupMbid,
      inc: "recordings+artist-credits+isrcs",
      status,
      limit: RELEASES_PER_ALBUM,
    },
    mbReleaseBrowseSchema,
    TTL.catalog,
  );
  return envelope?.releases ?? [];
}

/**
 * MBIDs per batched tag-profile request. Well inside both the 100-result page
 * limit and any sane URL length at ~47 characters per clause.
 */
const TAG_PROFILE_BATCH = 50;

export const musicbrainzCatalog: CatalogProvider = {
  id: MB_PROVIDER,

  async searchArtists(query, limit = 10) {
    const trimmed = query.trim();
    if (!trimmed) return sourced([], MB_PROVIDER, MB_CORE_LICENSE);

    const envelope = await mbFetch(
      "/artist",
      { query: trimmed, limit: Math.min(limit, MB_MAX_LIMIT) },
      mbArtistSearchSchema,
      TTL.search,
    );

    const results = (envelope?.artists ?? [])
      .map((raw) => mapArtistSearchResult(raw))
      .filter((artist): artist is ScoredArtistRef => artist !== null)
      .slice(0, limit);

    return sourced(results, MB_PROVIDER, MB_CORE_LICENSE);
  },

  async getTagProfiles(mbids) {
    const unique = [...new Set(mbids.filter((id) => id))];
    const profiles = new Map<string, Record<string, number>>();

    // One artist lookup per candidate would cost a second each, which is why
    // genre checking used to be rationed to a couple of dozen. The search
    // index takes a disjunction of ids and returns each artist's whole tag
    // list, so a hundred candidates cost two requests instead of a hundred.
    for (let i = 0; i < unique.length; i += TAG_PROFILE_BATCH) {
      const batch = unique.slice(i, i + TAG_PROFILE_BATCH);
      const envelope = await mbFetch(
        "/artist",
        {
          query: batch.map((id) => `arid:${id}`).join(" OR "),
          limit: MB_MAX_LIMIT,
        },
        mbArtistSearchSchema,
        TTL.tags,
      );

      for (const artist of parseEach(envelope?.artists, mbArtistSchema)) {
        const tags = mergeTags(artist.genres, artist.tags);
        if (Object.keys(tags).length > 0) profiles.set(artist.id, tags);
      }
    }

    // Tag-derived, so it carries the tag licence rather than the core one.
    return sourced(profiles, MB_PROVIDER, mbTagLicense());
  },

  async getArtist(mbid) {
    // Tags and genres ride along with the lookup, so the artist's whole tag
    // profile costs nothing beyond this one call.
    const artist = await mbFetch(
      `/artist/${encodeURIComponent(mbid)}`,
      { inc: "genres+tags" },
      mbArtistSchema,
      TTL.catalog,
    );
    if (!artist) return null;

    const lifeSpan = artist["life-span"];
    const detail: ArtistDetail = {
      mbid: artist.id,
      name: artist.name,
      sortName: artist["sort-name"] ?? undefined,
      disambiguation: artist.disambiguation || undefined,
      country: countryOf(artist),
      beginYear: parseYear(lifeSpan?.begin),
      endYear: parseYear(lifeSpan?.end),
      tags: mergeTags(artist.genres, artist.tags),
    };

    // The payload mixes CC0 facts with BY-NC-SA tags, so it carries the
    // stricter licence — otherwise a purge would leave the tags behind.
    return sourced(detail, MB_PROVIDER, mbTagLicense());
  },

  async getArtistAlbums(mbid) {
    const albums: AlbumRef[] = [];
    const seen = new Set<string>();
    let fetched = 0;

    for (let page = 0; page < MAX_ALBUM_PAGES; page++) {
      const envelope = await mbFetch(
        "/release-group",
        {
          artist: mbid,
          type: "album",
          limit: MB_MAX_LIMIT,
          offset: page * MB_MAX_LIMIT,
        },
        mbReleaseGroupBrowseSchema,
        TTL.catalog,
      );

      const groups = envelope?.["release-groups"] ?? [];
      for (const raw of groups) {
        const album = mapReleaseGroup(raw);
        // type=album filters on primary type only, but a release-group can
        // still come back as something else if the filter is ever relaxed.
        if (!album || album.primaryType !== "Album") continue;
        if (album.mbid) {
          if (seen.has(album.mbid)) continue;
          seen.add(album.mbid);
        }
        albums.push(album);
      }

      fetched += groups.length;
      const total = envelope?.["release-group-count"] ?? 0;
      if (groups.length < MB_MAX_LIMIT || fetched >= total) break;
    }

    return sourced(albums, MB_PROVIDER, MB_CORE_LICENSE);
  },

  async getAlbumTracks(album) {
    if (!album.mbid) return sourced([], MB_PROVIDER, MB_CORE_LICENSE);

    const official = await browseReleases(album.mbid, "official");
    // Live and bootleg-only release-groups have no official pressing at all;
    // one extra call beats returning an empty album.
    const releases = official.length > 0 ? official : await browseReleases(album.mbid);

    const best = pickBestRelease(releases);
    const tracks = best ? mapReleaseTracks(best, album) : [];
    return sourced(tracks, MB_PROVIDER, MB_CORE_LICENSE);
  },
};
