import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  similarArtists,
  type LicenseClass,
  type ProviderId,
} from "@/lib/db/schema";
import type { ScoredArtistRef } from "@/lib/providers/types";

export function saveSimilarArtists(
  artistId: string,
  neighbours: ScoredArtistRef[],
  source: ProviderId,
  licenseClass: LicenseClass,
  algorithm: string | undefined,
  now = Date.now(),
): void {
  if (neighbours.length === 0) return;

  db.transaction((tx) => {
    for (const neighbour of neighbours) {
      const values = {
        artistId,
        similarMbid: neighbour.mbid ?? null,
        similarName: neighbour.name,
        score: neighbour.score,
        algorithm: algorithm ?? null,
        source,
        licenseClass,
        fetchedAt: now,
      };
      tx.insert(similarArtists)
        .values(values)
        .onConflictDoUpdate({
          target: [
            similarArtists.artistId,
            similarArtists.similarName,
            similarArtists.source,
          ],
          set: values,
        })
        .run();
    }
  });
}

export function getSimilarArtists(
  artistId: string,
  limit = 50,
): { name: string; mbid: string | null; score: number; source: ProviderId }[] {
  return db
    .select({
      name: similarArtists.similarName,
      mbid: similarArtists.similarMbid,
      score: similarArtists.score,
      source: similarArtists.source,
    })
    .from(similarArtists)
    .where(eq(similarArtists.artistId, artistId))
    .orderBy(desc(similarArtists.score))
    .limit(limit)
    .all();
}
