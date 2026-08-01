import { and, desc, eq, like } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { artistTags, tags, type LicenseClass, type ProviderId } from "@/lib/db/schema";
import { newId } from "./ids";

export type TagRow = typeof tags.$inferSelect;
export type TagKind = TagRow["kind"];

export function findTagByName(name: string): TagRow | undefined {
  return db
    .select()
    .from(tags)
    .where(eq(tags.name, name.toLowerCase().trim()))
    .limit(1)
    .get();
}

/**
 * Resolves aliases to the preferred spelling ("hip-hop" -> "hip hop") so a
 * playlist seeded either way hits the same artist pool.
 */
export function resolveCanonicalTag(name: string): TagRow | undefined {
  const tag = findTagByName(name);
  if (!tag?.canonicalTagId) return tag;
  return db
    .select()
    .from(tags)
    .where(eq(tags.id, tag.canonicalTagId))
    .limit(1)
    .get();
}

export function upsertTag(
  name: string,
  kind: TagKind = "genre",
  canonicalTagId?: string,
): string {
  const normalized = name.toLowerCase().trim();
  const existing = findTagByName(normalized);
  if (existing) {
    if (canonicalTagId && existing.canonicalTagId !== canonicalTagId) {
      db.update(tags).set({ canonicalTagId }).where(eq(tags.id, existing.id)).run();
    }
    return existing.id;
  }

  const id = newId();
  db.insert(tags)
    .values({ id, name: normalized, kind, canonicalTagId: canonicalTagId ?? null })
    .onConflictDoNothing()
    .run();

  return findTagByName(normalized)?.id ?? id;
}

export function searchTags(query: string, limit = 20): TagRow[] {
  const term = query.toLowerCase().trim();
  if (!term) return [];
  return db
    .select()
    .from(tags)
    .where(like(tags.name, `${term}%`))
    .limit(limit)
    .all();
}

export function saveArtistTags(
  artistId: string,
  weights: Record<string, number>,
  source: ProviderId,
  licenseClass: LicenseClass,
  now = Date.now(),
): void {
  const entries = Object.entries(weights);
  if (entries.length === 0) return;

  db.transaction((tx) => {
    for (const [name, weight] of entries) {
      const tagId = upsertTag(name);
      const values = { artistId, tagId, weight, source, licenseClass, fetchedAt: now };
      tx.insert(artistTags)
        .values(values)
        .onConflictDoUpdate({
          target: [artistTags.artistId, artistTags.tagId, artistTags.source],
          set: values,
        })
        .run();
    }
  });
}

export function getArtistTags(artistId: string): { name: string; weight: number }[] {
  return db
    .select({ name: tags.name, weight: artistTags.weight })
    .from(artistTags)
    .innerJoin(tags, eq(tags.id, artistTags.tagId))
    .where(eq(artistTags.artistId, artistId))
    .orderBy(desc(artistTags.weight))
    .all();
}

/** Artists locally known to carry a tag, strongest association first. */
export function getArtistIdsForTag(tagName: string, limit = 200): { artistId: string; weight: number }[] {
  const tag = resolveCanonicalTag(tagName);
  if (!tag) return [];
  return db
    .select({ artistId: artistTags.artistId, weight: artistTags.weight })
    .from(artistTags)
    .where(eq(artistTags.tagId, tag.id))
    .orderBy(desc(artistTags.weight))
    .limit(limit)
    .all();
}

export function countArtistsForTag(tagName: string): number {
  const tag = resolveCanonicalTag(tagName);
  if (!tag) return 0;
  return db
    .select({ artistId: artistTags.artistId })
    .from(artistTags)
    .where(and(eq(artistTags.tagId, tag.id)))
    .all().length;
}
