import { userAgent } from "@/lib/config";
import type { ProviderId } from "@/lib/db/schema";
import { limiterFor, penalise } from "./rateLimiter";

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `${provider} responded ${status} for ${url}`);
    this.name = "ProviderHttpError";
  }
}

interface FetchOptions {
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  timeoutMs?: number;
  /** Treat these statuses as an empty result instead of an error. Default [404]. */
  emptyOn?: number[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30_000);
    }
  }
  const base = Math.min(1000 * 2 ** attempt, 15_000);
  // Jitter so parallel generations don't retry in lockstep.
  return base + Math.random() * 500;
}

/**
 * Every outbound provider call goes through here: it enforces the provider's
 * queue, sets the User-Agent MusicBrainz requires, and backs off on throttling.
 *
 * Returns null when the response status is in `emptyOn` — "this artist has no
 * Deezer page" is a normal outcome, not an error worth unwinding a generation.
 */
export async function providerFetch<T>(
  provider: ProviderId,
  url: string,
  options: FetchOptions = {},
): Promise<T | null> {
  const {
    headers = {},
    attempts = 3,
    timeoutMs = 15_000,
    emptyOn = [404],
  } = options;

  return limiterFor(provider).schedule(async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          headers: {
            // MusicBrainz blocks or throttles generic agents; the others are
            // simply happier when identified.
            "User-Agent": userAgent(),
            Accept: "application/json",
            ...headers,
          },
          signal: controller.signal,
        });

        if (emptyOn.includes(response.status)) return null;

        if (RETRYABLE.has(response.status)) {
          // MusicBrainz signals rate-limit violations with 503, not 429.
          const wait = backoffMs(attempt, response.headers.get("Retry-After"));
          if (response.status === 429 || response.status === 503) {
            await penalise(provider, Math.min(wait, 10_000));
          }
          lastError = new ProviderHttpError(provider, response.status, url);
          if (attempt < attempts - 1) {
            await sleep(wait);
            continue;
          }
          throw lastError;
        }

        if (!response.ok) {
          throw new ProviderHttpError(provider, response.status, url);
        }

        return (await response.json()) as T;
      } catch (error) {
        const err = error as Error;
        // Don't retry a deliberate non-retryable status.
        if (err instanceof ProviderHttpError && !RETRYABLE.has(err.status)) {
          throw err;
        }
        lastError = err;
        if (attempt < attempts - 1) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error(`${provider} request failed: ${url}`);
  });
}

/** Builds a query string, dropping undefined/empty values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}
