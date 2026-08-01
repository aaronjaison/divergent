import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { artists } from "@/lib/db/schema";
import type { ArtistDetail } from "@/lib/providers/types";
import { newId } from "./ids";

export type ArtistRow = typeof artists.$inferSelect;

export function findArtistByMbid(mbid: string): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.mbid, mbid)).limit(1).get();
}

export function findArtistsByMbids(mbids: string[]): ArtistRow[] {
  if (mbids.length === 0) return [];
  return db.select().from(artists).where(inArray(artists.mbid, mbids)).all();
}

export function findArtistById(id: string): ArtistRow | undefined {
  return db.select().from(artists).where(eq(artists.id, id)).limit(1).get();
}

interface UpsertArtistInput {
  mbid: string;
  name: string;
  sortName?: string;
  disambiguation?: string;
  country?: string;
  beginYear?: number;
  endYear?: number;
}

/** Returns the local row id, inserting or refreshing as needed. */
export function upsertArtist(input: UpsertArtistInput, now = Date.now()): string {
  const existing = findArtistByMbid(input.mbid);
  const id = existing?.id ?? newId();

  const values = {
    id,
    mbid: input.mbid,
    name: input.name,
    sortName: input.sortName ?? null,
    disambiguation: input.disambiguation ?? null,
    country: input.country ?? null,
    beginYear: input.beginYear ?? null,
    endYear: input.endYear ?? null,
    fetchedAt: now,
  };

  db.insert(artists)
    .values(values)
    .onConflictDoUpdate({ target: artists.mbid, set: values })
    .run();

  return id;
}

export function upsertArtistDetail(detail: ArtistDetail, now = Date.now()): string {
  return upsertArtist(
    {
      mbid: detail.mbid,
      name: detail.name,
      sortName: detail.sortName,
      disambiguation: detail.disambiguation,
      country: detail.country,
      beginYear: detail.beginYear,
      endYear: detail.endYear,
    },
    now,
  );
}
