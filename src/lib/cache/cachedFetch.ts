import { eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { apiCache, type ProviderId } from "@/lib/db/schema";

/**
 * Stale-while-revalidate cache in front of every external API.
 *
 * This is what makes MusicBrainz's 1 req/s survivable: a cold playlist takes
 * 30-60s of carefully paced calls, and every one of them is reusable for
 * months afterwards. A warm generation touches the network barely at all.
 */

export interface CacheTtl {
  /** ms after which the value is served but refreshed in the background. */
  fresh: number;
  /** ms after which the value is unusable and a fetch must block. */
  stale: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const TTL = {
  /** Artist/release/recording facts barely change. */
  catalog: { fresh: 90 * DAY, stale: 365 * DAY },
  tags: { fresh: 30 * DAY, stale: 180 * DAY },
  similarity: { fresh: 30 * DAY, stale: 180 * DAY },
  /** Popularity moves, but not fast enough to matter for hits-vs-deep-cuts. */
  popularity: { fresh: 7 * DAY, stale: 90 * DAY },
  search: { fresh: 7 * DAY, stale: 30 * DAY },
  /** Cross-platform links are effectively immutable. */
  permanent: { fresh: 365 * DAY, stale: 3650 * DAY },
} as const satisfies Record<string, CacheTtl>;

const inFlight = new Map<string, Promise<unknown>>();

function readCache(key: string) {
  return db
    .select()
    .from(apiCache)
    .where(eq(apiCache.cacheKey, key))
    .limit(1)
    .get();
}

function writeCache(
  key: string,
  provider: ProviderId,
  value: unknown,
  ttl: CacheTtl,
  now: number,
): void {
  const row = {
    cacheKey: key,
    provider,
    payload: JSON.stringify(value),
    fetchedAt: now,
    staleAt: now + ttl.fresh,
    expiresAt: now + ttl.stale,
  };
  db.insert(apiCache).values(row).onConflictDoUpdate({
    target: apiCache.cacheKey,
    set: row,
  }).run();
}

/**
 * Returns cached data when fresh, returns stale data immediately while
 * refreshing in the background, and blocks only on a genuine miss.
 *
 * Concurrent callers for the same key share one in-flight request, so ten
 * simultaneous generations seeded with "shoegaze" cost one MusicBrainz call.
 */
export async function cachedFetch<T>(
  key: string,
  provider: ProviderId,
  ttl: CacheTtl,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = readCache(key);

  if (cached && cached.expiresAt > now) {
    const value = JSON.parse(cached.payload) as T;

    if (cached.staleAt <= now && !inFlight.has(key)) {
      // Stale but usable: hand it back now, refresh behind the request.
      const revalidation = fetcher()
        .then((fresh) => {
          writeCache(key, provider, fresh, ttl, Date.now());
          return fresh;
        })
        .catch(() => {
          // A failed refresh must not surface: the caller already has data.
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, revalidation);
    }

    return value;
  }

  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = fetcher()
    .then((fresh) => {
      writeCache(key, provider, fresh, ttl, Date.now());
      return fresh;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

/** Deletes rows past their stale window. Cheap; safe to call opportunistically. */
export function pruneCache(now = Date.now()): number {
  const result = db.delete(apiCache).where(lt(apiCache.expiresAt, now)).run();
  return result.changes;
}

/** Test/diagnostic helper — clears the in-flight dedupe map. */
export function resetInFlight(): void {
  inFlight.clear();
}
