import { TTL } from "@/lib/cache/cachedFetch";
import type {
  ArtistRef,
  ScoredArtistRef,
  SimilarityProvider,
  SimilarRecording,
  Sourced,
} from "@/lib/providers/types";
import { sourced } from "@/lib/providers/types";
import {
  asRecord,
  isMbid,
  labsFetch,
  LB_LABS_ID,
  LB_LABS_LICENSE,
  normaliseScore,
  readNumber,
  readString,
  scoreDivisor,
  SIMILAR_ARTISTS_ALGORITHM,
  SIMILAR_RECORDINGS_ALGORITHM,
} from "./client";

interface ParsedRow {
  mbid: string;
  name: string;
  disambiguation?: string;
  raw: number;
}

/**
 * `country`/`beginYear`/`endYear` stay undefined: this endpoint returns `type`
 * and `gender` instead, neither of which maps onto ScoredArtistRef.
 */
export function mapSimilarArtists(
  raw: unknown,
  seedMbid: string,
  limit: number,
): ScoredArtistRef[] {
  if (!Array.isArray(raw)) return [];

  const seed = seedMbid.trim().toLowerCase();
  const rows: ParsedRow[] = [];

  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;

    const mbid = readString(row.artist_mbid)?.toLowerCase();
    const name = readString(row.name);
    const score = readNumber(row.score);
    if (!mbid || !name || score === undefined) continue;

    // The seed appears inside its own neighbour list, and not necessarily near
    // the top — Duster sits at #68 of its own 100 — so dropping the first row
    // does not catch it. Those rows are the ones with reference_mbid: null.
    if (mbid === seed) continue;

    rows.push({
      mbid,
      name,
      disambiguation: readString(row.comment),
      raw: score,
    });
  }

  const divisor = scoreDivisor(rows.map((row) => row.raw));

  return rows
    .map((row) => ({
      mbid: row.mbid,
      name: row.name,
      disambiguation: row.disambiguation,
      score: normaliseScore(row.raw, divisor),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

/**
 * Rows carry `artist_credit_mbids` and `artist_credit_name` already, so a
 * neighbouring RECORDING resolves to its artists without a second lookup —
 * which is what makes this affordable at one seed song per request.
 */
export function mapSimilarRecordings(
  raw: unknown,
  seedMbids: ReadonlySet<string>,
  limit: number,
): SimilarRecording[] {
  // Some labs endpoints answer with [[metadata], [rows]] rather than a bare
  // array of rows, so the response is flattened one level before parsing.
  const rows = Array.isArray(raw)
    ? raw.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    : [];

  const parsed: { row: SimilarRecording; raw: number }[] = [];

  for (const entry of rows) {
    const record = asRecord(entry);
    if (!record) continue;

    const recordingMbid = readString(record.recording_mbid)?.toLowerCase();
    const score = readNumber(record.score);
    if (!recordingMbid || score === undefined) continue;
    // The seed song is its own nearest neighbour.
    if (seedMbids.has(recordingMbid)) continue;

    const artistMbids = Array.isArray(record.artist_credit_mbids)
      ? record.artist_credit_mbids
          .map((value) => readString(value)?.toLowerCase())
          .filter((value): value is string => Boolean(value) && isMbid(value as string))
      : [];

    const artistName = readString(record.artist_credit_name);

    parsed.push({
      row: {
        recordingMbid,
        recordingName: readString(record.recording_name) ?? "",
        artistNames: artistName ? [artistName] : [],
        artistMbids,
        score: 0,
      },
      raw: score,
    });
  }

  const divisor = scoreDivisor(parsed.map((entry) => entry.raw));

  return parsed
    .map((entry) => ({ ...entry.row, score: normaliseScore(entry.raw, divisor) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

export const listenBrainzSimilarity: SimilarityProvider = {
  id: LB_LABS_ID,

  async getSimilarRecordings(
    recordingMbids: readonly string[],
    limit = 50,
  ): Promise<Sourced<SimilarRecording[]>> {
    const candidates = recordingMbids
      .map((mbid) => mbid.trim().toLowerCase())
      .filter((mbid) => isMbid(mbid));

    const seen = new Set(candidates);

    // Tried one at a time rather than all at once. The endpoint accepts a
    // comma-separated list, but it pools the neighbours of everything it is
    // given, so passing all six ids for one song would blend six versions'
    // audiences and lose which one actually had data. Stopping at the first
    // that answers keeps the request count at one for a well-known song.
    for (const mbid of candidates) {
      const raw = await labsFetch(
        "similar-recordings",
        { recording_mbids: mbid, algorithm: SIMILAR_RECORDINGS_ALGORITHM },
        TTL.similarity,
      );
      const mapped = mapSimilarRecordings(raw, seen, limit);
      if (mapped.length > 0) return sourced(mapped, LB_LABS_ID, LB_LABS_LICENSE);
    }

    return sourced<SimilarRecording[]>([], LB_LABS_ID, LB_LABS_LICENSE);
  },

  async getSimilarArtists(
    artist: ArtistRef,
    limit = 50,
  ): Promise<Sourced<ScoredArtistRef[]>> {
    const mbid = artist.mbid?.trim().toLowerCase();
    // MBID-only endpoint. An unresolved, name-only artist is a normal input
    // from upstream, so it costs nothing rather than throwing; a malformed one
    // stops here too, because labs answers that with a 400 rather than `[]`.
    if (!mbid || !isMbid(mbid)) {
      return sourced<ScoredArtistRef[]>([], LB_LABS_ID, LB_LABS_LICENSE);
    }

    const raw = await labsFetch(
      "similar-artists",
      { artist_mbids: mbid, algorithm: SIMILAR_ARTISTS_ALGORITHM },
      TTL.similarity,
    );

    return sourced(
      mapSimilarArtists(raw, mbid, limit),
      LB_LABS_ID,
      LB_LABS_LICENSE,
    );
  },
};
