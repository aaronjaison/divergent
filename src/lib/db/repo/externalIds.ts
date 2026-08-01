import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  externalIds,
  type LicenseClass,
  type ProviderId,
} from "@/lib/db/schema";

type EntityType = "artist" | "recording" | "release_group";
export type MatchConfidence = "isrc" | "exact" | "fuzzy";

export function saveExternalId(input: {
  entityType: EntityType;
  entityId: string;
  provider: ProviderId;
  externalId: string;
  url?: string;
  matchConfidence: MatchConfidence;
  licenseClass: LicenseClass;
  now?: number;
}): void {
  const values = {
    entityType: input.entityType,
    entityId: input.entityId,
    provider: input.provider,
    externalId: input.externalId,
    url: input.url ?? null,
    matchConfidence: input.matchConfidence,
    source: input.provider,
    licenseClass: input.licenseClass,
    fetchedAt: input.now ?? Date.now(),
  };

  db.insert(externalIds)
    .values(values)
    .onConflictDoUpdate({
      target: [externalIds.entityType, externalIds.entityId, externalIds.provider],
      set: values,
    })
    .run();
}

export function findExternalId(
  entityType: EntityType,
  entityId: string,
  provider: ProviderId,
): { externalId: string; matchConfidence: MatchConfidence; url: string | null } | undefined {
  return db
    .select({
      externalId: externalIds.externalId,
      matchConfidence: externalIds.matchConfidence,
      url: externalIds.url,
    })
    .from(externalIds)
    .where(
      and(
        eq(externalIds.entityType, entityType),
        eq(externalIds.entityId, entityId),
        eq(externalIds.provider, provider),
      ),
    )
    .limit(1)
    .get();
}
