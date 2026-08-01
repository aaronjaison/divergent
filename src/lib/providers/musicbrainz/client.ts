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
): Promise<z.infer<S> | null> {
  const query = qs({ ...params, fmt: "json" });
  // The whole query string is the key: the same release-group fetched with and
  // without inc=isrcs are materially different payloads and must not collide.
  const key = `mb:${path}?${query}`;

  const raw = await cachedFetch<unknown>(key, MB_PROVIDER, ttl, () =>
    providerFetch<unknown>(MB_PROVIDER, `${MB_BASE}${path}?${query}`),
  );
  if (raw === null || raw === undefined) return null;

  // Validated on read rather than before the write, so a schema fix takes
  // effect immediately instead of waiting out a 90-day cache entry.
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

export const mbReleaseGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  disambiguation: optionalString,
  "primary-type": optionalString,
  /** "" when unknown — not null, not absent. */
  "first-release-date": optionalString,
  "secondary-types": z.array(z.string()).nullish(),
});
export type MbReleaseGroup = z.infer<typeof mbReleaseGroupSchema>;

export const mbArtistCreditSchema = z.object({
  /** Credited-as name; can differ from artist.name and is what should display. */
  name: z.string(),
  joinphrase: optionalString,
  artist: z.object({ id: optionalString, name: optionalString }).nullish(),
});

export const mbRecordingSchema = z.object({
  id: optionalString,
  title: optionalString,
  length: z.number().nullish(),
  "first-release-date": optionalString,
  /** [] when there are none, absent when inc=isrcs wasn't requested. */
  isrcs: z.array(z.string()).nullish(),
  "artist-credit": z.array(mbArtistCreditSchema).nullish(),
});

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
