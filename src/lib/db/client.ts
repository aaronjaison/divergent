import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import * as schema from "./schema";

/**
 * Single shared connection. Cached on globalThis so Next's dev-mode module
 * reloading doesn't open a new SQLite handle on every hot reload.
 *
 * Swapping to Postgres later means replacing this file and schema.ts; nothing
 * else touches the driver, because all queries live in ./repo/*.
 */

declare global {
  var __divergentDb: ReturnType<typeof createDb> | undefined;
}

function createDb() {
  const file = path.resolve(process.cwd(), config.databaseFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  // WAL lets the background cache revalidation write while requests read.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Wait rather than throw immediately if another writer holds the lock.
  sqlite.pragma("busy_timeout = 5000");

  return drizzle(sqlite, { schema });
}

export const db = globalThis.__divergentDb ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalThis.__divergentDb = db;
}

export { schema };
