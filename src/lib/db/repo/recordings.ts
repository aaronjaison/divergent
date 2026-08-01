import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  popularity,
  recordingArtists,
  recordings,
  releaseGroups,
  type LicenseClass,
  type ProviderId,
} from "@/lib/db/schema";
import { normalizeIsrc, normalizeTitle } from "@/lib/text";
import { newId } from "./ids";

export type RecordingRow = typeof recordings.$inferSelect;
export type ReleaseGroupRow = typeof releaseGroups.$inferSelect;

export function upsertReleaseGroup(
  input: {
    mbid: string;
    artistId: string;
    title: string;
    primaryType?: string;
    secondaryTypes?: string[];
    firstReleaseYear?: number;
  },
  now = Date.now(),
): string {
  const existing = db
    .select({ id: releaseGroups.id })
    .from(releaseGroups)
    .where(eq(releaseGroups.mbid, input.mbid))
    .limit(1)
    .get();

  const id = existing?.id ?? newId();
  const values = {
    id,
    mbid: input.mbid,
    artistId: input.artistId,
    title: input.title,
    primaryType: input.primaryType ?? null,
    secondaryTypes: input.secondaryTypes?.length
      ? JSON.stringify(input.secondaryTypes)
      : null,
    firstReleaseYear: input.firstReleaseYear ?? null,
    fetchedAt: now,
  };

  db.insert(releaseGroups)
    .values(values)
    .onConflictDoUpdate({ target: releaseGroups.mbid, set: values })
    .run();

  return id;
}

export function upsertRecording(
  input: {
    mbid?: string;
    title: string;
    lengthMs?: number;
    isrc?: string;
    releaseGroupId?: string;
    artistIds?: string[];
  },
  now = Date.now(),
): string {
  const existing = input.mbid
    ? db.select().from(recordings).where(eq(recordings.mbid, input.mbid)).limit(1).get()
    : undefined;

  const id = existing?.id ?? newId();
  const values = {
    id,
    mbid: input.mbid ?? null,
    title: input.title,
    titleNorm: normalizeTitle(input.title),
    lengthMs: input.lengthMs ?? null,
    // Never overwrite a known ISRC with nothing — it's the best cross-platform key we have.
    isrc: normalizeIsrc(input.isrc) ?? existing?.isrc ?? null,
    releaseGroupId: input.releaseGroupId ?? existing?.releaseGroupId ?? null,
    fetchedAt: now,
  };

  if (input.mbid) {
    db.insert(recordings)
      .values(values)
      .onConflictDoUpdate({ target: recordings.mbid, set: values })
      .run();
  } else {
    db.insert(recordings).values(values).run();
  }

  for (const [index, artistId] of (input.artistIds ?? []).entries()) {
    db.insert(recordingArtists)
      .values({ recordingId: id, artistId, position: index })
      .onConflictDoNothing()
      .run();
  }

  return id;
}

export function findRecordingByMbid(mbid: string): RecordingRow | undefined {
  return db.select().from(recordings).where(eq(recordings.mbid, mbid)).limit(1).get();
}

export function savePopularity(
  input: {
    entityType: "artist" | "recording" | "release_group";
    entityId: string;
    scoreRaw: number;
    scoreNorm: number;
    source: ProviderId;
    licenseClass: LicenseClass;
  },
  now = Date.now(),
): void {
  const values = { ...input, fetchedAt: now };
  db.insert(popularity)
    .values(values)
    .onConflictDoUpdate({
      target: [popularity.entityType, popularity.entityId, popularity.source],
      set: values,
    })
    .run();
}

export function getPopularity(
  entityType: "artist" | "recording" | "release_group",
  entityId: string,
): { scoreRaw: number; scoreNorm: number; source: ProviderId }[] {
  return db
    .select({
      scoreRaw: popularity.scoreRaw,
      scoreNorm: popularity.scoreNorm,
      source: popularity.source,
    })
    .from(popularity)
    .where(
      and(eq(popularity.entityType, entityType), eq(popularity.entityId, entityId)),
    )
    .all();
}
