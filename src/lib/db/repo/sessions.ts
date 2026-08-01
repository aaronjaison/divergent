import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { newId } from "./ids";

/**
 * Anonymous sessions only in v1. The nullable userId column on the table is
 * where NextAuth attaches later, so adding accounts needs no migration.
 */
export function createSession(now = Date.now()): string {
  const id = newId();
  db.insert(sessions).values({ id, createdAt: now, lastSeenAt: now }).run();
  return id;
}

export function touchSession(id: string, now = Date.now()): boolean {
  const existing = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1)
    .get();

  if (!existing) return false;

  db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, id)).run();
  return true;
}

/** Returns the given session if it exists, otherwise creates a fresh one. */
export function ensureSession(id: string | undefined, now = Date.now()): string {
  if (id && touchSession(id, now)) return id;
  return createSession(now);
}
