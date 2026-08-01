import { config } from "@/lib/config";
import type { PlaylistTrack } from "@/lib/db/repo/playlists";

/**
 * Soundiiz handoff — the primary export path.
 *
 * Soundiiz's Playlist Import API takes a tracklist and returns a share URL.
 * The user reviews the tracks there, picks a destination (Spotify, Apple Music,
 * YouTube Music, Tidal and 40+ others) and Soundiiz performs the transfer using
 * its own OAuth connection to that service.
 *
 * This is why the app needs no Spotify API access: Spotify's developer platform
 * caps third-party apps at five users, but the user's own Soundiiz session has
 * no such limit. It also means we never handle anyone's streaming credentials.
 *
 * The endpoint is unauthenticated and its terms are not published, so it is
 * wrapped here alone and the file exports in ./formats.ts stay permanently
 * available as a fallback.
 */

const ENDPOINT = "https://soundiiz.com/go/import-playlist";

/** Soundiiz accepts 1-200 tracks, which matches its free tier's playlist cap. */
export const SOUNDIIZ_MAX_TRACKS = 200;

export class SoundiizError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "SoundiizError";
  }
}

interface SoundiizResponse {
  status?: string;
  nbTracks?: number;
  shareUrl?: string;
  expiresAt?: number;
  message?: string;
}

export interface SoundiizHandoff {
  shareUrl: string;
  /** Epoch ms. Soundiiz expires share URLs after ~24h. */
  expiresAt: number;
  trackCount: number;
}

export function buildTracklist(tracks: readonly PlaylistTrack[]) {
  return tracks.slice(0, SOUNDIIZ_MAX_TRACKS).map((track) => ({
    title: track.title,
    artists: track.artistNames,
  }));
}

/**
 * Called on user click only — never ahead of time. A share URL is valid for
 * about 24 hours, so generating one eagerly would usually mean handing over an
 * expired link. Callers persist the result and reuse it until it expires.
 */
export async function createSoundiizImport(input: {
  title: string;
  description?: string;
  tracks: readonly PlaylistTrack[];
}): Promise<SoundiizHandoff> {
  const tracklist = buildTracklist(input.tracks);

  if (tracklist.length === 0) {
    throw new SoundiizError("This playlist has no tracks to send.");
  }

  const body = {
    title: input.title,
    sourceName: config.appName,
    sourceLogo: `${config.baseUrl}/logo.png`,
    description: input.description ?? "",
    tracklist,
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new SoundiizError(
      "Could not reach Soundiiz. You can still download this playlist as CSV.",
      error,
    );
  }

  if (!response.ok) {
    throw new SoundiizError(
      `Soundiiz refused the playlist (HTTP ${response.status}). You can still download it as CSV.`,
    );
  }

  let parsed: SoundiizResponse;
  try {
    parsed = (await response.json()) as SoundiizResponse;
  } catch (error) {
    throw new SoundiizError("Soundiiz returned an unreadable response.", error);
  }

  if (!parsed.shareUrl) {
    throw new SoundiizError(
      parsed.message ?? "Soundiiz did not return a share link.",
    );
  }

  return {
    shareUrl: parsed.shareUrl,
    // expiresAt comes back in seconds; fall back to 24h if it is absent.
    expiresAt: parsed.expiresAt
      ? parsed.expiresAt * 1000
      : Date.now() + 24 * 60 * 60 * 1000,
    trackCount: parsed.nbTracks ?? tracklist.length,
  };
}

export function isHandoffValid(expiresAt: number | null, now = Date.now()): boolean {
  // Treat a link expiring within a minute as already gone, so a user doesn't
  // click through to a dead page.
  return expiresAt !== null && expiresAt - 60_000 > now;
}
