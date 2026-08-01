import { cachedFetch, type CacheTtl } from "@/lib/cache/cachedFetch";
import type { LicenseClass, ProviderId } from "@/lib/db/schema";
import { providerFetch, qs } from "@/lib/net/httpClient";
import { penalise } from "@/lib/net/rateLimiter";

/**
 * Shared plumbing for the Deezer provider.
 *
 * Deezer's open API needs no key, which is exactly why it is only usable while
 * the app is non-commercial — see the header of ./popularity.ts.
 */

export const BASE = "https://api.deezer.com";

export const DEEZER_PROVIDER: ProviderId = "deezer";
export const DEEZER_LICENSE: LicenseClass = "noncommercial";

export type DzParams = Record<string, string | number | undefined>;

// --- Defensive narrowing -------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Deezer ids arrive as JSON numbers; every id we store or send is text. */
export function idOf(value: unknown): string | undefined {
  const parsed = num(value);
  return parsed !== undefined && parsed > 0 ? String(parsed) : undefined;
}

/** Unwraps the `{data:[...]}` envelope every Deezer list endpoint uses. */
export function dataArray(payload: unknown): unknown[] {
  return isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
}

/** Deezer reports every duration in whole seconds; TrackRef stores milliseconds. */
export function secondsToMs(seconds: unknown): number | undefined {
  const parsed = num(seconds);
  return parsed !== undefined && parsed > 0 ? Math.round(parsed * 1000) : undefined;
}

/**
 * `release_date` is "YYYY-MM-DD", but Deezer emits "0000-00-00" for releases it
 * has no date for, which would otherwise become year 0 and poison date sorting.
 */
export function yearFromReleaseDate(value: unknown): number | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const year = Number(raw.slice(0, 4));
  if (!Number.isInteger(year)) return undefined;
  return year > 1000 && year <= new Date().getFullYear() + 1 ? year : undefined;
}

// --- Error handling ------------------------------------------------------

export interface DeezerErrorBody {
  type?: string;
  message?: string;
  code?: number;
}

export class DeezerApiError extends Error {
  constructor(
    readonly code: number | undefined,
    readonly errorType: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DeezerApiError";
  }
}

/** DataException — the id or path exists but has nothing behind it. */
export const NO_DATA_CODE = 800;

/**
 * Quota exhaustion (4) and "service busy" (700) also arrive as HTTP 200, so
 * httpClient's 429/503 backoff never fires for them and the queue would keep
 * firing at full reservoir rate into a provider that has just asked for quiet.
 */
export const THROTTLE_CODES: ReadonlySet<number> = new Set([4, 700]);
const THROTTLE_BACKOFF_MS = 10_000;

/**
 * Deezer answers missing ids, malformed paths and quota exhaustion with HTTP
 * 200 and an `{"error":{...}}` body. providerFetch only nulls out responses by
 * status, so its `emptyOn` never fires here and the error object would be
 * handed back as if it were the requested payload. Every response must be
 * sniffed for the key before anything else looks at it.
 */
export function readDeezerError(payload: unknown): DeezerErrorBody | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  return {
    type: str(payload.error.type),
    message: str(payload.error.message),
    code: num(payload.error.code),
  };
}

/**
 * Deterministic cache key. Params are sorted so argument order can't split one
 * logical request across two rows, and the whole key is lower-cased so
 * "Radiohead" and "radiohead" share an entry — the request itself still carries
 * the caller's original casing.
 */
export function cacheKeyFor(path: string, params: DzParams = {}): string {
  const sorted = Object.fromEntries(
    Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const query = qs(sorted);
  return `deezer:${path}${query ? `?${query}` : ""}`.toLowerCase();
}

/**
 * One cached, rate-limited Deezer call.
 *
 * Returns null when Deezer has no data for the request — a normal outcome
 * worth caching. Anything else (quota exhaustion, a malformed path, an
 * unreachable service) throws instead, because cachedFetch persists whatever
 * the fetcher resolves to: caching a null produced by a transient quota error
 * would blank out an artist for the whole 90-day catalog TTL.
 */
export async function dzFetch<T = unknown>(
  path: string,
  params: DzParams,
  ttl: CacheTtl,
): Promise<T | null> {
  return cachedFetch<T | null>(
    cacheKeyFor(path, params),
    DEEZER_PROVIDER,
    ttl,
    async () => {
      const query = qs(params);
      const url = `${BASE}${path}${query ? `?${query}` : ""}`;
      const payload = await providerFetch<unknown>(DEEZER_PROVIDER, url);
      if (payload === null) return null;

      const error = readDeezerError(payload);
      if (!error) return payload as T;
      if (error.code === NO_DATA_CODE) return null;

      if (error.code !== undefined && THROTTLE_CODES.has(error.code)) {
        await penalise(DEEZER_PROVIDER, THROTTLE_BACKOFF_MS);
      }

      throw new DeezerApiError(
        error.code,
        error.type,
        `deezer ${error.type ?? "error"} ${error.code ?? "?"} for ${path}: ${
          error.message ?? "no message"
        }`,
      );
    },
  );
}
