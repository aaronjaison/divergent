import { TTL } from "@/lib/cache/cachedFetch";
import { isExcludedReleaseType } from "@/lib/engine/titleFilters";
import type {
  AlbumRef,
  ArtistDetail,
  CatalogProvider,
  ScoredAlbumRef,
  ScoredArtistRef,
  ScoredRecordingRef,
  TrackRef,
} from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import {
  normalizeArtistName,
  normalizeIsrc,
  normalizeTitle,
  songIdentity,
} from "@/lib/text";
import {
  MB_CORE_LICENSE,
  MB_MAX_LIMIT,
  MB_PROVIDER,
  dismaxQuery,
  mbArtistSchema,
  mbArtistSearchSchema,
  mbFetch,
  mbRecordingSchema,
  mbRecordingSearchSchema,
  mbReleaseBrowseSchema,
  mbReleaseGroupBrowseSchema,
  mbReleaseGroupSchema,
  mbReleaseGroupSearchSchema,
  mbReleaseSchema,
  mbTagLicense,
  parseEach,
  type MbArtist,
  type MbRecording,
  type MbRelease,
  type MbReleaseGroup,
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

/**
 * How much anyone cares about a record, 0-1, from the VOTES on its tags rather
 * than the number of them. Saturates at TAG_VOTES_FULL.
 *
 * Counting distinct tags measures how many labels somebody typed, which is not
 * the same thing at all. Ride's *Nowhere* carries six tags of which four have
 * no votes — `rock:2, shoegaze:3, shoegazing:0, indie:0, noise pop:0,
 * shoegazer:0` — while an unrelated EP that happens to contain the query as a
 * phrase carries three at one vote each, and on tag count the EP wins. On votes
 * it is 5 against 3 and the landmark record is correctly ahead.
 *
 * `genres` is a curated subset of `tags` with identical counts, so only one of
 * the two is summed or every curated genre would count twice.
 */
const TAG_VOTES_FULL = 8;

function tagVotes(
  genres: readonly { count?: number | null }[] | null | undefined,
  tags: readonly { count?: number | null }[] | null | undefined,
): number {
  const source = (tags?.length ?? 0) > 0 ? tags : genres;
  const total = (source ?? []).reduce(
    (sum, entry) => sum + Math.max(0, entry.count ?? 0),
    0,
  );
  return Math.min(total, TAG_VOTES_FULL) / TAG_VOTES_FULL;
}

/**
 * How well a hit answers what was actually typed, 0-1.
 *
 * dismaxQuery throws every word at both the title and the artist field, which
 * is what makes "karma police radiohead" work at all — but it is symmetric, and
 * the index cannot tell which way round the listener meant. Asked for "in
 * rainbows radiohead", MusicBrainz scores an album titled *Radiohead* by a band
 * called *In Rainbows* at 100 and the actual record at 82: both match every
 * word across the two fields, and the wrong one matches them in fewer rows.
 * "black hole sun" is worse — a band named Black Hole takes the top three
 * places and Soundgarden does not appear at all.
 *
 * So relevance is re-measured here, against the query rather than the index:
 *
 * - `coverage`   how much of what was typed the hit accounts for at all. A
 *                word is credited to the title first, so a band whose name
 *                repeats its own album title cannot claim it twice.
 * - `precision`  how much of the TITLE the query accounts for, which is what
 *                separates "In Rainbows" from "In Rainbows Disk 2".
 * - `lead`       whether the query STARTS in the title. People type the song
 *                and then the artist, essentially always, and this is the only
 *                signal that recovers that ordering — it is what puts the real
 *                In Rainbows back on top.
 */
const COVERAGE_WEIGHT = 0.5;
const PRECISION_WEIGHT = 0.25;
const LEAD_WEIGHT = 0.25;

/**
 * How much MusicBrainz's own relevance still counts once queryFit has spoken.
 *
 * Small, and it has to be. Search scores are normalised so the top hit is
 * exactly 100, and dismaxQuery boosts an exact-phrase title match fivefold to
 * get short titles into the page at all — which compresses everything else into
 * the low twenties. Asked for "nowhere ride", an EP called *Nowhere Ride* takes
 * 100 and Ride's *Nowhere* takes 24, though it is plainly what was meant. The
 * boost buys recall; letting it carry a quarter of the ranking spends that
 * recall on the wrong record.
 */
const RELEVANCE_WEIGHT = 0.1;

/** Fit's share of an album's score; tag votes take the rest. */
const ALBUM_FIT_WEIGHT = 0.65;
const ALBUM_VOTES_WEIGHT = 0.25;

function searchWords(input: string): string[] {
  return normalizeTitle(input).split(" ").filter((word) => word.length > 0);
}

export function queryFit(
  query: string,
  title: string,
  artistNames: readonly string[],
): number {
  const asked = searchWords(query);
  if (asked.length === 0) return 0;

  const titleWords = new Set(searchWords(title));
  const artistWords = new Set(artistNames.flatMap(searchWords));

  let claimed = 0;
  let byTitle = 0;
  for (const word of asked) {
    if (titleWords.has(word)) {
      byTitle++;
      claimed++;
    } else if (artistWords.has(word)) {
      claimed++;
    }
  }

  const coverage = claimed / asked.length;
  const precision = titleWords.size > 0 ? byTitle / titleWords.size : 0;
  const lead = titleWords.has(asked[0]) ? 1 : 0;

  return (
    coverage * COVERAGE_WEIGHT + precision * PRECISION_WEIGHT + lead * LEAD_WEIGHT
  );
}

/** Display name and MBID of whoever the release or recording is credited to. */
function creditOf(
  credits: readonly { name: string; artist?: { id?: string | null } | null }[] | null | undefined,
): { artistNames: string[]; artistMbid?: string } {
  const list = credits ?? [];
  return {
    artistNames: list.map((credit) => credit.name).filter((name) => name.length > 0),
    artistMbid: list[0]?.artist?.id ?? undefined,
  };
}

/**
 * One album search hit, already scored against the query.
 *
 * Scored here rather than by the caller because the vote counts it needs are on
 * the raw entity and do not survive into ScoredAlbumRef — mergeTags normalises
 * them away, which is right for a genre profile and wrong for judging whether
 * anyone has heard of the record.
 */
export function mapReleaseGroupSearchHit(
  raw: unknown,
  query = "",
): ScoredAlbumRef | null {
  const parsed = mbReleaseGroupSchema.safeParse(raw);
  if (!parsed.success) return null;
  const group = parsed.data;

  const tags = mergeTags(group.genres, group.tags);
  const credit = creditOf(group["artist-credit"]);

  return {
    mbid: group.id,
    title: group.title,
    year: parseYear(group["first-release-date"]),
    primaryType: group["primary-type"] ?? undefined,
    secondaryTypes: group["secondary-types"] ?? [],
    disambiguation: group.disambiguation || undefined,
    // Re-scored against the query for the reason queryFit exists: asked for
    // "in rainbows radiohead", the index puts an album called Radiohead by a
    // band called In Rainbows above the record.
    score: clamp01(
      queryFit(query, group.title, credit.artistNames) * ALBUM_FIT_WEIGHT +
        clamp01((group.score ?? 0) / 100) * RELEVANCE_WEIGHT +
        tagVotes(group.genres, group.tags) * ALBUM_VOTES_WEIGHT,
    ),
    ...credit,
    tags: Object.keys(tags).length > 0 ? tags : undefined,
  };
}

/**
 * How suitable a release-group is as the album to show for a song.
 *
 * MusicBrainz lists every release a recording ever appeared on, and the first
 * is rarely the right one: "Boy's a liar" comes back attached to a DJ-mix and a
 * Now That's What I Call... compilation alongside the single it actually came
 * from. Lower is better.
 */
function albumPreference(group: MbReleaseGroup): number {
  if (isExcludedReleaseType(group["secondary-types"] ?? [])) return 3;
  switch (group["primary-type"]) {
    case "Album":
      return 0;
    case "EP":
      return 1;
    default:
      return 2;
  }
}

/**
 * How likely this particular recording id is the one the listening data knows
 * about. Higher is better.
 *
 * Measured, not guessed: asked for neighbours of Denzel Curry's "RICKY", the
 * first search hit returned nothing and the second — the one carrying an ISRC
 * and a real duration — returned a hundred. A recording row without either is
 * usually a stub for a tracklisting nobody has played.
 */
function recordingConfidence(recording: MbRecording): number {
  const isrcs = (recording.isrcs ?? []).length;
  const releases = (recording.releases ?? []).length;
  return (
    (isrcs > 0 ? 4 : 0) +
    (recording.length ? 2 : 0) +
    Math.min(releases, 4) * 0.5 +
    clamp01((recording.score ?? 0) / 100)
  );
}

/**
 * Recording entries at which a song counts as thoroughly released. A song
 * pressed, reissued and compiled across forty years has a dozen of them; a
 * cover uploaded once has one. Capped low because it saturates fast — and
 * because the page is only a hundred rows deep, so a much-covered song's
 * original competes with its own covers for room to show its depth.
 */
const DEEP_CATALOGUE = 8;

/**
 * Collapses a recording search into one row per song.
 *
 * A search for a hit single returns the single, the album cut, the deluxe
 * reissue, two compilations and a video — eleven rows for one song, which is
 * unusable as a picker. They fold into a single entry that keeps every
 * candidate MBID, because which of them the similarity index knows about cannot
 * be determined from here.
 */
export function collapseRecordings(
  raws: readonly unknown[] | null | undefined,
  limit: number,
  query = "",
): ScoredRecordingRef[] {
  const parsed = parseEach(raws, mbRecordingSchema)
    // A video "recording" is a music video, not a song.
    .filter((recording) => recording.id && recording.title && !recording.video);

  const groups = new Map<string, MbRecording[]>();
  for (const recording of parsed) {
    const credit = creditOf(recording["artist-credit"]);
    const key = `${normalizeArtistName(credit.artistNames[0] ?? "")}::${songIdentity(
      recording.title as string,
    )}`;
    const group = groups.get(key);
    if (group) group.push(recording);
    else groups.set(key, [recording]);
  }

  const out: ScoredRecordingRef[] = [];
  // A whole page was fetched, so an unranked title-only query can still return
  // a hundred groups. Scoring is cheap; the sort at the end is what decides.
  for (const members of groups.values()) {
    const ordered = members
      .slice()
      .sort((a, b) => recordingConfidence(b) - recordingConfidence(a));
    const best = ordered[0];

    // Tags are pooled across the whole group: they are sparse enough that the
    // one row carrying "2-step" is often not the one with the ISRC.
    const tags = mergeTags(
      ordered.flatMap((recording) => recording.genres ?? []),
      ordered.flatMap((recording) => recording.tags ?? []),
    );

    const album = ordered
      .flatMap((recording) => recording.releases ?? [])
      .map((release) => release["release-group"])
      .filter((group): group is MbReleaseGroup => Boolean(group))
      .sort((a, b) => albumPreference(a) - albumPreference(b))[0];

    const credit = creditOf(best["artist-credit"]);

    out.push({
      mbids: ordered.map((recording) => recording.id as string),
      title: best.title as string,
      ...credit,
      album: album?.title,
      albumMbid: album?.id,
      year:
        parseYear(best["first-release-date"]) ??
        parseYear(album?.["first-release-date"]),
      durationMs: ordered.find((recording) => recording.length)?.length ?? undefined,
      isrc: firstIsrc(ordered.flatMap((recording) => recording.isrcs ?? [])),
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      /**
       * queryFit leads because the index's own relevance is the thing being
       * corrected — see its docs, and RELEVANCE_WEIGHT for why Lucene's score
       * only gets a small vote once the phrase boost has distorted it.
       *
       * Catalogue depth then settles the rest, which is almost entirely the
       * original against its covers. Note what is NOT here: recordingConfidence
       * ranks a recording by ISRC, duration and release count, and using it
       * between songs put every cover above the original. Asked for "running up
       * that hill", the first ten results were Club for Five, Kidz Bop and
       * eight others, all carrying an ISRC — while Kate Bush's 1985 original,
       * present eight times over, carries none in the search index. An ISRC
       * means a digital distributor filed one, not that this is the version
       * anybody meant. Confidence still picks which id within a song to trust,
       * where it was measured and where it is right.
       */
      score: clamp01(
        queryFit(query, best.title as string, credit.artistNames) * 0.5 +
          clamp01(Math.max(...ordered.map((recording) => recording.score ?? 0)) / 100) *
            RELEVANCE_WEIGHT +
          (Math.min(ordered.length, DEEP_CATALOGUE) / DEEP_CATALOGUE) * 0.4,
      ),
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
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

  async searchRecordings(query, limit = 10) {
    const search = dismaxQuery(query, ["recording", "artist"]);
    if (!search) return sourced([], MB_PROVIDER, mbTagLicense());

    // A whole page is fetched however small `limit` is: a famous song occupies
    // dozens of rows on its own — "Karma Police" fills 99 of 100 — and the
    // collapse can only be as good as the rows it sees.
    const envelope = await mbFetch(
      "/recording",
      { query: search, limit: MB_MAX_LIMIT },
      mbRecordingSearchSchema,
      TTL.search,
    );

    // Recording tags ride along, so this carries the tag licence.
    return sourced(
      collapseRecordings(envelope?.recordings, limit, query),
      MB_PROVIDER,
      mbTagLicense(),
    );
  },

  async searchReleaseGroups(query, limit = 10) {
    const search = dismaxQuery(query, ["releasegroup", "artist"]);
    if (!search) return sourced([], MB_PROVIDER, mbTagLicense());

    const envelope = await mbFetch(
      "/release-group",
      { query: search, limit: MB_MAX_LIMIT },
      mbReleaseGroupSearchSchema,
      TTL.search,
    );

    const albums = (envelope?.["release-groups"] ?? [])
      .map((raw) => mapReleaseGroupSearchHit(raw, query))
      .filter((album): album is ScoredAlbumRef => album !== null)
      // Live records, compilations and remix albums make poor seeds: their tags
      // describe the packaging as much as the music.
      .filter(
        (album) =>
          (album.primaryType === "Album" || album.primaryType === "EP") &&
          !isExcludedReleaseType(album.secondaryTypes),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sourced(albums, MB_PROVIDER, mbTagLicense());
  },

  async getReleaseGroupProfiles(mbids) {
    const unique = [...new Set(mbids.filter((id) => id))];
    const profiles = new Map<string, Record<string, number>>();

    // Same batching trick as getTagProfiles: the search index takes a
    // disjunction of ids and hands back each album's whole tag list, so fifty
    // albums cost one request rather than fifty rate-limited lookups.
    for (let i = 0; i < unique.length; i += TAG_PROFILE_BATCH) {
      const batch = unique.slice(i, i + TAG_PROFILE_BATCH);
      const envelope = await mbFetch(
        "/release-group",
        {
          query: batch.map((id) => `rgid:${id}`).join(" OR "),
          limit: MB_MAX_LIMIT,
        },
        mbReleaseGroupSearchSchema,
        TTL.tags,
      );

      for (const group of parseEach(envelope?.["release-groups"], mbReleaseGroupSchema)) {
        const tags = mergeTags(group.genres, group.tags);
        if (Object.keys(tags).length > 0) profiles.set(group.id, tags);
      }
    }

    return sourced(profiles, MB_PROVIDER, mbTagLicense());
  },

  async getRecordingProfiles(mbids) {
    const unique = [...new Set(mbids.filter((id) => id))];
    const profiles = new Map<string, Record<string, number>>();

    // Recordings are tagged far more thinly than artists or albums — most have
    // nothing at all — but where a tag does exist it is the sharpest signal
    // available, because it describes this song rather than its author's
    // career. Batched for the same reason as the other two: fifty seeds and
    // their alternate ids would otherwise be fifty rate-limited lookups.
    for (let i = 0; i < unique.length; i += TAG_PROFILE_BATCH) {
      const batch = unique.slice(i, i + TAG_PROFILE_BATCH);
      const envelope = await mbFetch(
        "/recording",
        {
          query: batch.map((id) => `rid:${id}`).join(" OR "),
          limit: MB_MAX_LIMIT,
        },
        mbRecordingSearchSchema,
        TTL.tags,
      );

      for (const recording of parseEach(envelope?.recordings, mbRecordingSchema)) {
        if (!recording.id) continue;
        const tags = mergeTags(recording.genres, recording.tags);
        if (Object.keys(tags).length > 0) profiles.set(recording.id, tags);
      }
    }

    return sourced(profiles, MB_PROVIDER, mbTagLicense());
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
