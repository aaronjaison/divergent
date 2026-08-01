import { cookies } from "next/headers";
import { createSession, touchSession } from "@/lib/db/repo/sessions";

/**
 * Anonymous sessions. No accounts in v1: a playlist belongs to whoever holds
 * the cookie. The sessions table already carries a nullable userId, so adding
 * real accounts later needs no migration.
 */

const COOKIE = "divergent_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Reads the current session, creating one if needed. Requires a mutable request context. */
export async function getOrCreateSessionId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE)?.value;

  if (existing && touchSession(existing)) return existing;

  const id = createSession();
  store.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return id;
}

/**
 * Reads the session without creating one. Safe in Server Components, where
 * setting a cookie throws.
 */
export async function readSessionId(): Promise<string | undefined> {
  const store = await cookies();
  const existing = store.get(COOKIE)?.value;
  if (existing && touchSession(existing)) return existing;
  return undefined;
}
