import { loadEnv } from "./loadEnv";

loadEnv();

/**
 * Loads the MusicBrainz genre vocabulary into the local tags table.
 *
 * Tag autocomplete then runs entirely against SQLite, which keeps it instant
 * while every other lookup in the app is rate-limited to 1 req/s.
 *
 * Run once after `npm run db:migrate`; safe to re-run.
 */
async function main() {
  const { fetchAllGenres } = await import("@/lib/providers/musicbrainz/tags");
  const { upsertTag } = await import("@/lib/db/repo/tags");

  console.log("Fetching the MusicBrainz genre list…");
  const genres = await fetchAllGenres();

  if (genres.length === 0) {
    console.error("No genres returned. Check network access and try again.");
    process.exitCode = 1;
    return;
  }

  let inserted = 0;
  for (const genre of genres) {
    upsertTag(genre, "genre");
    inserted++;
  }

  console.log(`Seeded ${inserted} genres.`);

  // Common spellings MusicBrainz normalises differently from how people type.
  const aliases: [alias: string, canonical: string][] = [
    ["hip-hop", "hip hop"],
    ["r&b", "rhythm and blues"],
    ["synth pop", "synthpop"],
    ["post rock", "post-rock"],
    ["post punk", "post-punk"],
    ["drum and bass", "drum and bass"],
    ["lo fi", "lo-fi"],
    ["trip-hop", "trip hop"],
  ];

  let aliased = 0;
  for (const [alias, canonical] of aliases) {
    const { findTagByName } = await import("@/lib/db/repo/tags");
    const target = findTagByName(canonical);
    if (!target || alias === canonical) continue;
    upsertTag(alias, "genre", target.id);
    aliased++;
  }

  console.log(`Linked ${aliased} spelling aliases.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
