import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  playlistTracks,
  playlists,
  type PlaylistKind,
  type PlaylistStatus,
} from "@/lib/db/schema";
import { newPublicId } from "./ids";

export type PlaylistRow = typeof playlists.$inferSelect;
export type PlaylistTrackRow = typeof playlistTracks.$inferSelect;

/**
 * The snapshot written into playlist_tracks. Deliberately denormalised: a
 * playlist must still export correctly after purge-noncommercial.ts deletes
 * the provider rows the tracks were assembled from.
 */
export interface PlaylistTrackInput {
  recordingId?: string;
  title: string;
  artistNames: string[];
  album?: string;
  isrc?: string;
  durationMs?: number;
  year?: number;
  reason?: string;
}

export function createPlaylist(input: {
  sessionId: string;
  kind: PlaylistKind;
  title: string;
  params: unknown;
  now?: number;
}): string {
  const id = newPublicId();
  db.insert(playlists)
    .values({
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      title: input.title,
      paramsJson: JSON.stringify(input.params),
      status: "building",
      createdAt: input.now ?? Date.now(),
    })
    .run();
  return id;
}

export function findPlaylist(id: string): PlaylistRow | undefined {
  return db.select().from(playlists).where(eq(playlists.id, id)).limit(1).get();
}

export function listPlaylistsForSession(sessionId: string, limit = 10): PlaylistRow[] {
  return db
    .select()
    .from(playlists)
    .where(eq(playlists.sessionId, sessionId))
    .orderBy(desc(playlists.createdAt))
    .limit(limit)
    .all();
}

export function updateProgress(
  id: string,
  progress: { done: number; total: number; label?: string },
): void {
  db.update(playlists)
    .set({
      progressDone: progress.done,
      progressTotal: progress.total,
      progressLabel: progress.label ?? null,
    })
    .where(eq(playlists.id, id))
    .run();
}

export function finishPlaylist(
  id: string,
  status: PlaylistStatus,
  warnings: string[] = [],
): void {
  db.update(playlists)
    .set({
      status,
      warningsJson: warnings.length ? JSON.stringify(warnings) : null,
    })
    .where(eq(playlists.id, id))
    .run();
}

export function replacePlaylistTracks(
  playlistId: string,
  tracks: PlaylistTrackInput[],
): void {
  db.transaction((tx) => {
    tx.delete(playlistTracks).where(eq(playlistTracks.playlistId, playlistId)).run();
    if (tracks.length === 0) return;

    tx.insert(playlistTracks)
      .values(
        tracks.map((track, index) => ({
          playlistId,
          position: index,
          recordingId: track.recordingId ?? null,
          title: track.title,
          artistNames: JSON.stringify(track.artistNames),
          album: track.album ?? null,
          isrc: track.isrc ?? null,
          durationMs: track.durationMs ?? null,
          year: track.year ?? null,
          reason: track.reason ?? null,
        })),
      )
      .run();
  });
}

export interface PlaylistTrack {
  position: number;
  recordingId: string | null;
  title: string;
  artistNames: string[];
  album: string | null;
  isrc: string | null;
  durationMs: number | null;
  year: number | null;
  reason: string | null;
}

export function getPlaylistTracks(playlistId: string): PlaylistTrack[] {
  return db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(playlistTracks.position)
    .all()
    .map((row) => ({
      position: row.position,
      recordingId: row.recordingId,
      title: row.title,
      artistNames: safeParseNames(row.artistNames),
      album: row.album,
      isrc: row.isrc,
      durationMs: row.durationMs,
      year: row.year,
      reason: row.reason,
    }));
}

function safeParseNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((n): n is string => typeof n === "string");
  } catch {
    // Fall through: a corrupt row should not break an export.
  }
  return [raw];
}

export function saveSoundiizHandoff(
  id: string,
  url: string,
  expiresAt: number,
): void {
  db.update(playlists)
    .set({ soundiizUrl: url, soundiizExpiresAt: expiresAt })
    .where(eq(playlists.id, id))
    .run();
}

export function parseWarnings(row: PlaylistRow): string[] {
  if (!row.warningsJson) return [];
  try {
    const parsed: unknown = JSON.parse(row.warningsJson);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}
