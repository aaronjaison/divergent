import { z } from "zod";
import { cachedFetch, TTL, type CacheTtl } from "@/lib/cache/cachedFetch";
import { config } from "@/lib/config";
import type { LicenseClass, ProviderId } from "@/lib/db/schema";
import { providerFetch, qs } from "@/lib/net/httpClient";

/**
 * MusicBrainz WS/2 transport and response shapes.
 *
 * Two things about this API drive everything below: 1 req/s, and responses
 * whose optional fields are optional in three different ways — absent, null,
 * or "". Every schema here is therefore maximally permissive; the mapping
 * layer decides what a missing value means.
 */

export const MB_PROVIDER: ProviderId = "musicbrainz";
export const MB_BASE = "https://musicbrainz.org/ws/2";

/** Every list endpoint silently caps here — browse, search and genre/all alike. */
export const MB_MAX_LIMIT = 100;

/** Core catalogue — artists, releases, recordings, ISRCs — is CC0. */
export const MB_CORE_LICENSE: LicenseClass = "open";

/**
 * Genres and tags are CC BY-NC-SA, so anything derived from them has to stay
 * purgeable until a MetaBrainz supporter tier covers it. This conditional is
 * the reason licenseClass is carried per row rather than per provider.
 */
export function mbTagLicense(): LicenseClass {
  return config.metabrainzCommercialLicense ? "licensed" : "noncommercial";
}

export type MbParams = Record<string, string | number | undefined>;

/**
 * Fetches, caches and validates one WS/2 call.
 *
 * Returns null for a 404, for a body that doesn't match the schema, and for
 * nothing else — a 400 means the request was built wrong and must surface as
 * an error rather than as "this artist has no albums".
 */
export async function mbFetch<S extends z.ZodType>(
  path: string,
  params: MbParams,
  schema: S,
  ttl: CacheTtl = TTL.catalog,
  /** Abandons the call if it is still queued when the caller gives up. */
  signal?: AbortSignal,
): Promise<z.infer<S> | null> {
  const query = qs({ ...params, fmt: "json" });
  // The whole query string is the key: the same release-group fetched with and
  // without inc=isrcs are materially different payloads and must not collide.
  const key = `mb:${path}?${query}`;

  const raw = await cachedFetch<unknown>(key, MB_PROVIDER, ttl, () =>
    providerFetch<unknown>(MB_PROVIDER, `${MB_BASE}${path}?${query}`, { signal }),
  );
  if (raw === null || raw === undefined) return null;

  // Validated on read rather than before the write, so a schema fix takes
  // effect immediately instead of waiting out a 90-day cache entry.
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Lucene metacharacters. Search endpoints parse the query, so an unescaped one
 * in user input is at best a different search and at worst a 400 — a title as
 * ordinary as "Where Is My Mind?" ends in a wildcard operator.
 */
const LUCENE_SYNTAX = /([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g;

/**
 * Builds a query that scores every word against every listed field, so a hit
 * matching more of them ranks higher.
 *
 * People type "karma police radiohead" as one string, and neither obvious
 * approach survives that. Plain free text is actively wrong: it matches the
 * artist's name inside a TITLE, so "Karma Police (Radiohead Cover)" by Car Seat
 * Headrest scores a perfect 100 and Radiohead's own recording does not make the
 * first twelve results. Searching the title field alone is no better, because
 * "Alison" and "Ricky" each match several hundred unrelated songs.
 *
 * Pairing each word against both fields fixes it, because Lucene scores a
 * document by how many clauses it satisfies: the real recording matches
 * `recording:karma`, `recording:police` AND `artist:radiohead` — three — where
 * the cover matches two. Measured across seven queries this returns the right
 * song first every time.
 *
 * The whole query is then added again as a boosted PHRASE against the title
 * field, which is what rescues short and common titles. Left to the per-word
 * clauses alone, "kid a" matches 170,000 release-groups and Radiohead's is not
 * among the first hundred — a two-letter clause discriminates nothing, so the
 * page fills with self-titled records by bands called Kid. With the phrase
 * clause the album is first. It costs nothing when it does not match, which is
 * every query where the listener typed the artist too.
 */
const PHRASE_BOOST = 5;

export function dismaxQuery(input: string, fields: readonly string[]): string {
  const trimmed = input.trim();
  const words = trimmed
    .replace(LUCENE_SYNTAX, "\\$1")
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0 || fields.length === 0) return "";

  const perWord = words
    .map((word) => `(${fields.map((field) => `${field}:${word}`).join(" OR ")})`)
    .join(" ");

  if (words.length < 2) return perWord;

  // Only quotes and backslashes need escaping inside a phrase; everything else
  // is literal there, and escaping it would stop the phrase matching.
  const phrase = trimmed.replace(/["\\]/g, "\\$&");
  return `(${fields[0]}:"${phrase}")^${PHRASE_BOOST} ${perWord}`;
}

/**
 * Parses list items independently, dropping the ones that don't fit. MB
 * occasionally returns an entity shape we don't model; one of those must not
 * empty an otherwise usable page.
 */
export function parseEach<S extends z.ZodType>(
  items: readonly unknown[] | null | undefined,
  schema: S,
): z.infer<S>[] {
  if (!items) return [];
  const out: z.infer<S>[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// --- Entity schemas ------------------------------------------------------

const optionalString = z.string().nullish();

export const mbLifeSpanSchema = z.object({
  /** Partial dates: "1991", "1990-04", "1997-05-21". */
  begin: optionalString,
  end: optionalString,
  ended: z.boolean().nullish(),
});

export const mbTagSchema = z.object({
  name: z.string(),
  /** Search results carry 0 and negative counts; lookups only return >= 1. */
  count: z.number().nullish(),
});

export const mbGenreSchema = z.object({
  id: optionalString,
  name: z.string(),
  count: z.number().nullish(),
});

/**
 * Covers both the search hit and the lookup: search adds `score` and omits
 * `genres`, lookup does the reverse, and neither is worth a second type.
 */
export const mbArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  "sort-name": optionalString,
  disambiguation: optionalString,
  country: optionalString,
  type: optionalString,
  score: z.number().nullish(),
  area: z
    .object({ "iso-3166-1-codes": z.array(z.string()).nullish() })
    .nullish(),
  "life-span": mbLifeSpanSchema.nullish(),
  tags: z.array(mbTagSchema).nullish(),
  genres: z.array(mbGenreSchema).nullish(),
});
export type MbArtist = z.infer<typeof mbArtistSchema>;

export const mbArtistCreditSchema = z.object({
  /** Credited-as name; can differ from artist.name and is what should display. */
  name: z.string(),
  joinphrase: optionalString,
  artist: z.object({ id: optionalString, name: optionalString }).nullish(),
});

export const mbReleaseGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  disambiguation: optionalString,
  "primary-type": optionalString,
  /** "" when unknown — not null, not absent. */
  "first-release-date": optionalString,
  "secondary-types": z.array(z.string()).nullish(),
  // Present on search hits only, and worth more than it looks: a release-group
  // search returns the album's whole tag list inline, and album tags are far
  // more specific than the artist's — "Kid A" is tagged electronic and
  // experimental where Radiohead as a whole is alternative rock.
  score: z.number().nullish(),
  tags: z.array(mbTagSchema).nullish(),
  genres: z.array(mbGenreSchema).nullish(),
  "artist-credit": z.array(mbArtistCreditSchema).nullish(),
});
export type MbReleaseGroup = z.infer<typeof mbReleaseGroupSchema>;

export const mbRecordingSchema = z.object({
  id: optionalString,
  title: optionalString,
  length: z.number().nullish(),
  "first-release-date": optionalString,
  /** [] when there are none, absent when inc=isrcs wasn't requested. */
  isrcs: z.array(z.string()).nullish(),
  "artist-credit": z.array(mbArtistCreditSchema).nullish(),
  // Search hits only. Recording tags are sparse — most recordings carry none —
  // but they are the sharpest signal in the catalogue when they are there:
  // PinkPantheress's "Just for me" is tagged 2-step and contemporary r&b,
  // where her artist profile is far broader.
  score: z.number().nullish(),
  tags: z.array(mbTagSchema).nullish(),
  genres: z.array(mbGenreSchema).nullish(),
  /** Search hits carry the releases a recording appears on, each with its group. */
  releases: z
    .array(
      z.object({
        id: optionalString,
        title: optionalString,
        date: optionalString,
        "release-group": mbReleaseGroupSchema.nullish(),
      }),
    )
    .nullish(),
  /** True for video "recordings", which are not songs and must not be seeds. */
  video: z.boolean().nullish(),
});
export type MbRecording = z.infer<typeof mbRecordingSchema>;

export const mbTrackSchema = z.object({
  id: optionalString,
  position: z.number().nullish(),
  /** A string, and not always numeric — vinyl uses "A1"/"B2". */
  number: optionalString,
  title: optionalString,
  length: z.number().nullish(),
  "artist-credit": z.array(mbArtistCreditSchema).nullish(),
  recording: mbRecordingSchema.nullish(),
});

export const mbMediumSchema = z.object({
  position: z.number().nullish(),
  "track-offset": z.number().nullish(),
  "track-count": z.number().nullish(),
  format: optionalString,
  title: optionalString,
  tracks: z.array(mbTrackSchema).nullish(),
});

export const mbReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: optionalString,
  date: optionalString,
  country: optionalString,
  "artist-credit": z.array(mbArtistCreditSchema).nullish(),
  media: z.array(mbMediumSchema).nullish(),
});
export type MbRelease = z.infer<typeof mbReleaseSchema>;

// --- Envelopes -----------------------------------------------------------

// Items stay `unknown` here and are parsed one by one downstream; a single
// malformed entry would otherwise take the whole page down with it.

export const mbArtistSearchSchema = z.object({
  count: z.number().nullish(),
  offset: z.number().nullish(),
  artists: z.array(z.unknown()).nullish(),
});

export const mbRecordingSearchSchema = z.object({
  count: z.number().nullish(),
  offset: z.number().nullish(),
  recordings: z.array(z.unknown()).nullish(),
});

/**
 * The SEARCH envelope, which uses count/offset — unlike the browse envelope
 * below, which prefixes its keys. Same entity, two different shapes.
 */
export const mbReleaseGroupSearchSchema = z.object({
  count: z.number().nullish(),
  offset: z.number().nullish(),
  "release-groups": z.array(z.unknown()).nullish(),
});

/** Browse endpoints prefix their envelope keys instead of using count/offset. */
export const mbReleaseGroupBrowseSchema = z.object({
  "release-group-count": z.number().nullish(),
  "release-group-offset": z.number().nullish(),
  "release-groups": z.array(z.unknown()).nullish(),
});

export const mbReleaseBrowseSchema = z.object({
  "release-count": z.number().nullish(),
  "release-offset": z.number().nullish(),
  releases: z.array(z.unknown()).nullish(),
});

export const mbGenreAllSchema = z.object({
  "genre-count": z.number().nullish(),
  "genre-offset": z.number().nullish(),
  genres: z.array(z.unknown()).nullish(),
});
