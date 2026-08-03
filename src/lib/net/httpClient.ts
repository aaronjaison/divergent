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
  /**
   * Abandons the request if the caller has stopped caring by the time the
   * queue reaches it.
   *
   * What this saves is the round trip, not the queue slot — the limiter paces
   * on job starts and charges an abandoned job the same gap as a real one, and
   * the test in httpClient.test.ts measured exactly that when the first version
   * of this comment claimed otherwise. The round trip is the part worth saving
   * anyway: MusicBrainz paces at 1.1 seconds but answers in anywhere from 0.2
   * to 20 of them, measured on the same query shape minutes apart. A search box
   * firing on each pause stacks its abandoned queries in front of the one the
   * person actually meant, and the last keystroke waits out every one of their
   * responses. Skipping those responses is most of the wait.
   */
  signal?: AbortSignal;
}

/** Thrown when a caller abandons a request; not a provider failure. */
export class RequestAbortedError extends Error {
  constructor() {
    super("Request abandoned by the caller");
    this.name = "RequestAbortedError";
  }
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
    signal,
  } = options;

  return limiterFor(provider).schedule(async () => {
    // Checked here rather than before queueing, because here is where it pays:
    // the job has just waited out everything ahead of it, and abandoning now
    // hands the slot straight to the next one instead of spending a second and
    // a wire call on an answer nobody will read.
    if (signal?.aborted) throw new RequestAbortedError();

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Checked before dispatch, and deliberately not while the request is in
        // flight. A call already on the wire is nearly free to finish and its
        // answer goes into the cache, where a retype collects it for nothing —
        // and cachedFetch hands one in-flight promise to every caller waiting
        // on the same key, so tearing it down would fail the other callers too.
        if (signal?.aborted) throw new RequestAbortedError();
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
        if (err instanceof RequestAbortedError) throw err;
        // A retry is a fresh queue slot, so an abandoned call must not take one.
        if (signal?.aborted) throw new RequestAbortedError();
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
