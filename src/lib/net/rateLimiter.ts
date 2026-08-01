import Bottleneck from "bottleneck";
import type { ProviderId } from "@/lib/db/schema";

/**
 * One queue per provider, shared process-wide.
 *
 * These limits are the reason the app must run as a single long-lived Node
 * process (next.config.ts sets output: 'standalone'). Under a serverless
 * target each parallel instance would hold its own limiter and collectively
 * blow through MusicBrainz's 1 req/s, which gets an app throttled or blocked.
 *
 * The Limiter interface is the seam for a Redis-backed implementation if the
 * deployment ever needs to fan out across machines.
 */
export interface Limiter {
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

const limiters: Partial<Record<ProviderId, Bottleneck>> = {};

const SETTINGS: Record<ProviderId, Bottleneck.ConstructorOptions> = {
  // Documented hard limit: 1 req/s per IP, averaged. 1100ms buys headroom for
  // clock jitter; exceeding it returns 503, which httpClient treats as a rate
  // signal rather than a server fault.
  musicbrainz: { maxConcurrent: 1, minTime: 1100 },
  // No published limit and no SLA. MetaBrainz is actively fighting scraper
  // load, so this is a courtesy pace, not a requirement.
  lb_labs: { maxConcurrent: 1, minTime: 1000 },
  listenbrainz: { maxConcurrent: 1, minTime: 1000 },
  // Historically ~50 req/5s per IP on the open endpoints. Reservoir refills
  // every 5s to stay comfortably under.
  deezer: {
    maxConcurrent: 4,
    minTime: 120,
    reservoir: 45,
    reservoirRefreshAmount: 45,
    reservoirRefreshInterval: 5000,
  },
  // 5 req/s per the community-established ceiling.
  lastfm: { maxConcurrent: 1, minTime: 220 },
  soundcharts: { maxConcurrent: 4, minTime: 100 },
  discogs: { maxConcurrent: 1, minTime: 1100 },
  // ~10 req/min per IP without a key.
  songlink: { maxConcurrent: 1, minTime: 6500 },
  // ~20 req/min, stated but variable.
  itunes: { maxConcurrent: 1, minTime: 3200 },
};

export function limiterFor(provider: ProviderId): Limiter {
  let limiter = limiters[provider];
  if (!limiter) {
    limiter = new Bottleneck(SETTINGS[provider]);
    limiters[provider] = limiter;
  }
  return limiter;
}

/**
 * Pauses a provider's queue after a 429/503. Callers keep queueing normally;
 * everything simply waits out the penalty.
 */
export async function penalise(
  provider: ProviderId,
  ms: number,
): Promise<void> {
  const limiter = limiterFor(provider) as Bottleneck;
  const current = SETTINGS[provider].minTime ?? 0;
  limiter.updateSettings({ minTime: Math.max(current, ms) });
  setTimeout(() => limiter.updateSettings({ minTime: current }), ms * 2);
}
