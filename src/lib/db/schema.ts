import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Schema notes:
 *
 * - MusicBrainz IDs (mbid) are the canonical spine. Everything else — Deezer
 *   ids, Spotify ids, ISRCs — hangs off them.
 * - Every table holding data derived from an external source carries
 *   `source` / `licenseClass` / `fetchedAt`. `licenseClass` is what makes the
 *   commercial transition a DELETE rather than a rewrite: data from
 *   non-commercial sources (Deezer, Last.fm, MusicBrainz tags before a
 *   MetaBrainz tier) can be purged and re-fetched from licensed providers.
 * - Postgres portability: ids are app-generated nanoids, timestamps are
 *   epoch-ms integers, JSON is stored as text and parsed with zod. No SQLite-
 *   specific SQL anywhere, and all access goes through src/lib/db/repo/*.
 */

export const PROVIDER_IDS = [
  "musicbrainz",
  "lb_labs",
  "listenbrainz",
  "deezer",
  "lastfm",
  "soundcharts",
  "discogs",
  "songlink",
  "itunes",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const LICENSE_CLASSES = ["open", "noncommercial", "licensed"] as const;
/**
 * open        — CC0 / public domain. Safe commercially, forever.
 * noncommercial — usable while the app is non-commercial; must be purged or
 *                 re-sourced before monetising.
 * licensed    — covered by a paid agreement (MetaBrainz tier, Soundcharts).
 */
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

const provenance = {
  source: text("source").$type<ProviderId>().notNull(),
  licenseClass: text("license_class").$type<LicenseClass>().notNull(),
  fetchedAt: integer("fetched_at").notNull(),
};

// --- Catalog -------------------------------------------------------------

export const artists = sqliteTable(
  "artists",
  {
    id: text("id").primaryKey(),
    mbid: text("mbid").notNull(),
    name: text("name").notNull(),
    sortName: text("sort_name"),
    /** MusicBrainz's short qualifier, e.g. "UK punk band" — vital for search UX. */
    disambiguation: text("disambiguation"),
    country: text("country"),
    beginYear: integer("begin_year"),
    endYear: integer("end_year"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("artists_mbid_idx").on(t.mbid),
    index("artists_name_idx").on(t.name),
  ],
);

export const releaseGroups = sqliteTable(
  "release_groups",
  {
    id: text("id").primaryKey(),
    mbid: text("mbid").notNull(),
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    primaryType: text("primary_type"),
    /** JSON array. Carries "Live"/"Compilation"/"Soundtrack" — all excluded from deep cuts. */
    secondaryTypes: text("secondary_types"),
    firstReleaseYear: integer("first_release_year"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("release_groups_mbid_idx").on(t.mbid),
    index("release_groups_artist_idx").on(t.artistId),
  ],
);

export const recordings = sqliteTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    mbid: text("mbid"),
    title: text("title").notNull(),
    /** Normalised title (lowercase, punctuation and "(remastered)"-style suffixes stripped) for dedupe. */
    titleNorm: text("title_norm").notNull(),
    lengthMs: integer("length_ms"),
    isrc: text("isrc"),
    releaseGroupId: text("release_group_id").references(() => releaseGroups.id, {
      onDelete: "set null",
    }),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("recordings_mbid_idx").on(t.mbid),
    index("recordings_title_norm_idx").on(t.titleNorm),
    index("recordings_isrc_idx").on(t.isrc),
    index("recordings_release_group_idx").on(t.releaseGroupId),
  ],
);

export const recordingArtists = sqliteTable(
  "recording_artists",
  {
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.recordingId, t.artistId] }),
    index("recording_artists_artist_idx").on(t.artistId),
  ],
);

// --- Tags / genres -------------------------------------------------------

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<"genre" | "mood" | "style" | "other">().notNull(),
    /** Points at the preferred spelling, e.g. "hip hop" for "hip-hop". Null when this IS the canonical row. */
    canonicalTagId: text("canonical_tag_id"),
  },
  (t) => [uniqueIndex("tags_name_idx").on(t.name)],
);

export const artistTags = sqliteTable(
  "artist_tags",
  {
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** 0-1, normalised within the artist so a heavily-tagged artist doesn't dominate. */
    weight: real("weight").notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.tagId, t.source] }),
    index("artist_tags_tag_idx").on(t.tagId, t.weight),
    index("artist_tags_license_idx").on(t.licenseClass),
  ],
);

// --- Discovery signals ---------------------------------------------------

export const similarArtists = sqliteTable(
  "similar_artists",
  {
    artistId: text("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    /** The neighbour may not have a local artists row yet, so store the raw mbid/name. */
    similarMbid: text("similar_mbid"),
    similarName: text("similar_name").notNull(),
    score: real("score").notNull(),
    algorithm: text("algorithm"),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.artistId, t.similarName, t.source] }),
    index("similar_artists_score_idx").on(t.artistId, t.score),
    index("similar_artists_license_idx").on(t.licenseClass),
  ],
);

export const popularity = sqliteTable(
  "popularity",
  {
    entityType: text("entity_type")
      .$type<"artist" | "recording" | "release_group">()
      .notNull(),
    entityId: text("entity_id").notNull(),
    /** Raw provider value (Deezer rank 0-1M, Last.fm playcount, ...). */
    scoreRaw: real("score_raw").notNull(),
    /** 0-100, normalised within the source so providers can be compared. */
    scoreNorm: real("score_norm").notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId, t.source] }),
    index("popularity_license_idx").on(t.licenseClass),
  ],
);

export const externalIds = sqliteTable(
  "external_ids",
  {
    entityType: text("entity_type")
      .$type<"artist" | "recording" | "release_group">()
      .notNull(),
    entityId: text("entity_id").notNull(),
    provider: text("provider").$type<ProviderId>().notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    /**
     * How the match was made. 'fuzzy' matches are excluded from the "hard"
     * obscurity band, where a wrong track is hardest for a listener to spot.
     */
    matchConfidence: text("match_confidence")
      .$type<"isrc" | "exact" | "fuzzy">()
      .notNull(),
    ...provenance,
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId, t.provider] }),
    index("external_ids_lookup_idx").on(t.provider, t.externalId),
    index("external_ids_license_idx").on(t.licenseClass),
  ],
);

// --- Infrastructure ------------------------------------------------------

export const apiCache = sqliteTable(
  "api_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    provider: text("provider").$type<ProviderId>().notNull(),
    payload: text("payload").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
    /** After this, serve stale and revalidate in the background. */
    staleAt: integer("stale_at").notNull(),
    /** After this, the row is useless; a miss forces a blocking fetch. */
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("api_cache_expires_idx").on(t.expiresAt),
    index("api_cache_provider_idx").on(t.provider),
  ],
);

export const sessions = sqliteTable("sessions", {
  /** Opaque token from an httpOnly cookie. No accounts in v1. */
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  /** Reserved for NextAuth later — adding accounts needs no migration. */
  userId: text("user_id"),
});

// --- Playlists -----------------------------------------------------------

export const PLAYLIST_KINDS = [
  "style",
  "introduce_famous",
  "introduce_deep",
  "introduce_blend",
  /** Similar artists only — the seed artist is deliberately absent. */
  "discover_artists",
  /** Seeded by up to five songs; the seed artists are deliberately absent. */
  "sounds_like_tracks",
  /** Seeded by up to three albums; the seed artists are deliberately absent. */
  "sounds_like_albums",
] as const;
export type PlaylistKind = (typeof PLAYLIST_KINDS)[number];

export const PLAYLIST_STATUSES = [
  "building",
  "ready",
  "partial",
  "failed",
] as const;
export type PlaylistStatus = (typeof PLAYLIST_STATUSES)[number];

export const playlists = sqliteTable(
  "playlists",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PlaylistKind>().notNull(),
    title: text("title").notNull(),
    /** JSON: seeds, constraints and the RNG seed, so a playlist can be rebuilt exactly. */
    paramsJson: text("params_json").notNull(),
    status: text("status").$type<PlaylistStatus>().notNull(),
    /** JSON array of user-facing warnings, e.g. "only 18 of 25 tracks found". */
    warningsJson: text("warnings_json"),
    progressDone: integer("progress_done").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    progressLabel: text("progress_label"),
    soundiizUrl: text("soundiiz_url"),
    soundiizExpiresAt: integer("soundiiz_expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("playlists_session_idx").on(t.sessionId, t.createdAt),
    index("playlists_status_idx").on(t.status),
  ],
);

export const playlistTracks = sqliteTable(
  "playlist_tracks",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** Nullable and ON DELETE SET NULL: the snapshot below is what exports read. */
    recordingId: text("recording_id").references(() => recordings.id, {
      onDelete: "set null",
    }),
    // Denormalised snapshot. Exports must keep working after a non-commercial
    // purge deletes the rows these came from.
    title: text("title").notNull(),
    /** JSON array of artist names. */
    artistNames: text("artist_names").notNull(),
    album: text("album"),
    isrc: text("isrc"),
    durationMs: integer("duration_ms"),
    year: integer("year"),
    /** Why this track is here: "top track", "deep cut from Vespertine (2001)". */
    reason: text("reason"),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.position] })],
);

export const schemaVersion = sqliteTable("schema_version", {
  id: integer("id").primaryKey(),
  appliedAt: integer("applied_at")
    .notNull()
    .default(sql`0`),
});
