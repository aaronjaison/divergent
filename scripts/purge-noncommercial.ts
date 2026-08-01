import Database from "better-sqlite3";
import path from "node:path";
import { loadEnv } from "./loadEnv";

/**
 * Removes every row sourced from a non-commercial provider.
 *
 * Run this before launching commercially. Several of the free data sources the
 * app uses during development are non-commercial by licence:
 *
 *   - Deezer      — terms are explicitly non-commercial, registration closed
 *   - Last.fm     — non-commercial without a negotiated agreement
 *   - MusicBrainz genres/tags — CC BY-NC-SA (core data is CC0 and stays)
 *
 * The replacements are Soundcharts for popularity (self-serve, ~$50/mo) and a
 * MetaBrainz supporter tier for the tag data (~$100/mo), after which
 * METABRAINZ_COMMERCIAL_LICENSE=true makes new tag rows 'licensed'.
 *
 * Playlists are deliberately untouched: playlist_tracks holds a denormalised
 * snapshot, so exports keep working on data the user already generated.
 *
 * Usage:
 *   npm run purge:noncommercial            # dry run, reports counts only
 *   npm run purge:noncommercial -- --apply # actually delete
 */

loadEnv();

const apply = process.argv.includes("--apply");
const file = path.resolve(
  process.cwd(),
  process.env.DATABASE_FILE ?? "./data/app.sqlite",
);

const db = new Database(file);
db.pragma("foreign_keys = ON");

/** Tables carrying a license_class column, i.e. everything derived from a provider. */
const LICENSED_TABLES = [
  "artist_tags",
  "similar_artists",
  "popularity",
  "external_ids",
] as const;

/** Cached provider responses are re-fetchable, so the whole cache goes. */
const NONCOMMERCIAL_PROVIDERS = ["deezer", "lastfm"];

interface Report {
  table: string;
  rows: number;
}

const report: Report[] = [];

for (const table of LICENSED_TABLES) {
  const { count } = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE license_class = 'noncommercial'`)
    .get() as { count: number };
  report.push({ table, rows: count });

  if (apply && count > 0) {
    db.prepare(`DELETE FROM ${table} WHERE license_class = 'noncommercial'`).run();
  }
}

const placeholders = NONCOMMERCIAL_PROVIDERS.map(() => "?").join(", ");
const { count: cacheRows } = db
  .prepare(`SELECT COUNT(*) AS count FROM api_cache WHERE provider IN (${placeholders})`)
  .get(...NONCOMMERCIAL_PROVIDERS) as { count: number };
report.push({ table: "api_cache", rows: cacheRows });

if (apply && cacheRows > 0) {
  db.prepare(`DELETE FROM api_cache WHERE provider IN (${placeholders})`).run(
    ...NONCOMMERCIAL_PROVIDERS,
  );
}

const { count: playlistTracks } = db
  .prepare("SELECT COUNT(*) AS count FROM playlist_tracks")
  .get() as { count: number };

const total = report.reduce((sum, row) => sum + row.rows, 0);

console.log(`Database: ${file}`);
console.log(apply ? "\nMode: APPLY (deleting)\n" : "\nMode: dry run (no changes)\n");

for (const row of report) {
  console.log(`  ${row.table.padEnd(18)} ${String(row.rows).padStart(8)} rows`);
}

console.log(`\n  ${"TOTAL".padEnd(18)} ${String(total).padStart(8)} rows`);
console.log(
  `\n  ${playlistTracks} playlist tracks are preserved — exports use a denormalised snapshot.`,
);

if (apply) {
  db.exec("VACUUM");
  console.log("\nPurge complete. Re-fetch popularity from a licensed provider before launch.");
} else {
  console.log("\nRe-run with --apply to delete.");
}

db.close();
