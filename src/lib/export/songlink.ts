import { cachedFetch, TTL } from "@/lib/cache/cachedFetch";
import { providerFetch, qs } from "@/lib/net/httpClient";
import { normalizeIsrc } from "@/lib/text";

/**
 * Odesli (song.link) — per-track "open in your service" links.
 *
 * Free and keyless, but roughly 10 requests per minute per IP, so this is only
 * ever called from a user clicking one track. Never call it in bulk: a 25-track
 * playlist would take two and a half minutes and exhaust the budget for
 * everyone else.
 *
 * Results are cached permanently — a track's identity on Spotify or Apple Music
 * does not change.
 */

const ENDPOINT = "https://api.song.link/v1-alpha.1/links";

export interface PlatformLinks {
  /** platform name -> url, e.g. { spotify: "https://open.spotify.com/track/..." } */
  links: Record<string, string>;
  pageUrl?: string;
}

interface OdesliResponse {
  pageUrl?: string;
  linksByPlatform?: Record<string, { url?: string } | undefined>;
}

const INTERESTING = [
  "spotify",
  "appleMusic",
  "youtubeMusic",
  "tidal",
  "deezer",
  "amazonMusic",
  "soundcloud",
] as const;

/**
 * Looks up a track by ISRC when we have one — Odesli resolves those exactly,
 * whereas a title/artist search is a guess.
 */
export async function lookupLinks(input: {
  isrc?: string | null;
  spotifyId?: string;
  userCountry?: string;
}): Promise<PlatformLinks | null> {
  const isrc = normalizeIsrc(input.isrc);

  // Odesli's alpha API takes either a platform id or a URL; without one of
  // those there is nothing reliable to ask for.
  const params: Record<string, string | undefined> = input.spotifyId
    ? { platform: "spotify", type: "song", id: input.spotifyId }
    : isrc
      ? { url: `https://open.spotify.com/search/isrc:${isrc}` }
      : {};

  if (Object.keys(params).length === 0) return null;
  if (input.userCountry) params.userCountry = input.userCountry;

  const key = `songlink:${qs(params)}`;

  return cachedFetch(key, "songlink", TTL.permanent, async () => {
    const response = await providerFetch<OdesliResponse>(
      "songlink",
      `${ENDPOINT}?${qs(params)}`,
      // A track Odesli has never seen is a normal miss, not an error.
      { emptyOn: [404, 400] },
    );

    if (!response?.linksByPlatform) return null;

    const links: Record<string, string> = {};
    for (const platform of INTERESTING) {
      const url = response.linksByPlatform[platform]?.url;
      if (url) links[platform] = url;
    }

    return Object.keys(links).length > 0
      ? { links, pageUrl: response.pageUrl }
      : null;
  });
}

export const PLATFORM_LABELS: Record<string, string> = {
  spotify: "Spotify",
  appleMusic: "Apple Music",
  youtubeMusic: "YouTube Music",
  tidal: "Tidal",
  deezer: "Deezer",
  amazonMusic: "Amazon Music",
  soundcloud: "SoundCloud",
};
