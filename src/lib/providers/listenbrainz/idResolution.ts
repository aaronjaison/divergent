import { TTL } from "@/lib/cache/cachedFetch";
import type { IdResolutionProvider, Sourced } from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import {
  asRecord,
  isMbid,
  labsFetch,
  LB_LABS_ID,
  LB_LABS_LICENSE,
  readString,
} from "./client";

export type IdTarget = "spotify" | "apple";

/**
 * Note `recording_mbid` is singular here while similar-artists takes
 * `artist_mbids` — param names are not consistent across this API, and the
 * wrong one is a 400. There is also no batching: the field is a scalar, so
 * repeating it fails uuid validation.
 */
const ENDPOINTS: Record<IdTarget, { path: string; idsKey: string }> = {
  spotify: { path: "spotify-id-from-mbid", idsKey: "spotify_track_ids" },
  apple: { path: "apple-music-id-from-mbid", idsKey: "apple_music_track_ids" },
};

/**
 * The id array holds per-market and per-release duplicates — Glory Box resolves
 * to eight Spotify ids — in no documented order, and there is no field to rank
 * them by, so the first usable one is as good as any.
 */
export function extractTrackId(raw: unknown, target: IdTarget): string | null {
  if (!Array.isArray(raw)) return null;

  const { idsKey } = ENDPOINTS[target];

  for (const entry of raw) {
    const ids = asRecord(entry)?.[idsKey];
    if (!Array.isArray(ids)) continue;

    for (const id of ids) {
      const value = readString(id);
      if (value) return value;
    }
  }

  return null;
}

export const listenBrainzIds: IdResolutionProvider = {
  id: LB_LABS_ID,

  async idFromMbid(
    recordingMbid: string,
    target: IdTarget,
  ): Promise<Sourced<string | null>> {
    const mbid = recordingMbid.trim().toLowerCase();
    // Blank and malformed both stop here: labs 400s on anything that isn't a
    // uuid, and that 400 is otherwise indistinguishable from a broken request.
    if (!isMbid(mbid)) {
      return sourced<string | null>(null, LB_LABS_ID, LB_LABS_LICENSE);
    }

    // These tables key off the *canonical* recording MBID only: any other MBID
    // for the same recording misses with an empty array, even for the same
    // track by the same artist. Expect a low hit rate unless the MBID came from
    // labs' own recording-search.
    const raw = await labsFetch(
      ENDPOINTS[target].path,
      { recording_mbid: mbid },
      TTL.permanent,
    );

    return sourced(extractTrackId(raw, target), LB_LABS_ID, LB_LABS_LICENSE);
  },
};
