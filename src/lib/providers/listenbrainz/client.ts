import { cachedFetch, type CacheTtl } from "@/lib/cache/cachedFetch";
import { config } from "@/lib/config";
import type { LicenseClass, ProviderId } from "@/lib/db/schema";
import { providerFetch, qs } from "@/lib/net/httpClient";

/**
 * ListenBrainz Labs — the derived/experimental side of ListenBrainz. No auth,
 * no published rate limit, every endpoint answers on /<endpoint>/json and
 * returns a top-level JSON array.
 */
export const LB_LABS_BASE = "https://labs.api.listenbrainz.org";

export const LB_LABS_ID: ProviderId = "lb_labs";

/** Listens and the MusicBrainz *core* metadata joined onto them are both CC0. */
export const LB_LABS_LICENSE: LicenseClass = "open";

/**
 * Tag similarity is the exception, and it has to be stamped separately.
 * ListenBrainz has no tag vocabulary of its own — it correlates MusicBrainz's
 * tags, which are CC BY-NC-SA, and the results say so plainly ("classic pop and
 * rock", "4ad", "queer"). A derived tag→tag table inherits that, so it must
 * clear on the same switch as musicbrainz/client.ts's mbTagLicense(); stamping
 * it 'open' would leave it behind in the pre-launch purge.
 */
export function labsTagLicense(): LicenseClass {
  return config.metabrainzCommercialLicense ? "licensed" : "noncommercial";
}

/**
 * Session-based co-listening: two artists score highly when listeners play them
 * within the same session. `days_7500` is the listen window, `session_300` the
 * gap in seconds that ends a session, `contribution_5` the cap on how much a
 * single user can add to one pair (so a superfan cannot invent a neighbour),
 * `threshold_10` the minimum pair count kept.
 *
 * The server accepts six exact strings and 400s on anything else, so none of
 * these tokens are tunable — `limit_100` included. Every response is 100 rows
 * regardless, and must be sliced client-side.
 */
export const SIMILAR_ARTISTS_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

/**
 * The recording-level equivalent, and a DIFFERENT enum: the artist algorithm
 * string is rejected here with a 400. This one has no `filter_True` and uses
 * `threshold_15_limit_50`, which are the only combinations the endpoint accepts.
 *
 * Coverage is per-recording rather than per-song, which is the thing to know
 * before relying on it: MusicBrainz holds a separate recording for the single,
 * the album cut and every compilation appearance, and only the ones people
 * actually played are in the index. Asked about the first search hit for Denzel
 * Curry's "RICKY" it returns nothing; asked about the second it returns a
 * hundred neighbours. Callers must try every candidate id for a song.
 */
export const SIMILAR_RECORDINGS_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30";

export type LabsParams = Record<string, string | number | undefined>;

/**
 * Sorted, so a caller reordering its params cannot split the cache entry, and
 * values are encoded so free text carrying `&` or `=` — tags are user input —
 * cannot forge a second param and alias another query's key.
 */
export function labsCacheKey(endpoint: string, params: LabsParams): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .sort();
  return `${LB_LABS_ID}:${endpoint}:${parts.join("&")}`;
}

/**
 * Labs never 404s and never signals a miss with an error: an unknown-but-
 * well-formed MBID and a nonsense tag both answer 200 with `[]`. The only 400
 * is a request this code built wrong — a malformed MBID, or a missing/renamed
 * required param — and it is deliberately left to throw. Swallowing it would
 * write `[]` into the cache for 30-3650 days and turn a renamed parameter into
 * a silent, permanent "this artist has no neighbours". Callers screen their own
 * MBIDs with isMbid() so the one recoverable 400 never reaches the queue.
 *
 * `T` is the caller's claim about the row shape. Nothing in this provider makes
 * that claim: every caller leaves it `unknown` and narrows row by row, because
 * which fields these endpoints omit varies per record.
 */
export async function labsFetch<T = unknown>(
  endpoint: string,
  params: LabsParams,
  ttl: CacheTtl,
): Promise<T[]> {
  const url = `${LB_LABS_BASE}/${endpoint}/json?${qs(params)}`;

  return cachedFetch<T[]>(
    labsCacheKey(endpoint, params),
    LB_LABS_ID,
    ttl,
    async () => {
      const data = await providerFetch<unknown>(LB_LABS_ID, url);
      return (Array.isArray(data) ? data : []) as T[];
    },
  );
}

const MBID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Expects the lowercased form; every caller lowercases before the request. */
export function isMbid(value: string): boolean {
  return MBID_PATTERN.test(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Empty strings are this API's "no value" for text fields, e.g. `comment`. */
export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Labs scores are raw co-occurrence counts with no ceiling, and that ceiling
 * tracks how heavily listened the *seed* is: Radiohead's neighbours top out
 * around 11k, Duster's around 800. A fixed divisor would flatten every obscure
 * seed's neighbours to ~0, so normalisation is always per-response.
 *
 * Returns 1 when there is nothing to divide by, which leaves an all-zero
 * response at 0 instead of NaN.
 */
export function scoreDivisor(scores: number[]): number {
  const max = scores.reduce((best, score) => (score > best ? score : best), 0);
  return max > 0 ? max : 1;
}

export function normaliseScore(raw: number, divisor: number): number {
  return Math.min(1, Math.max(0, raw / divisor));
}
