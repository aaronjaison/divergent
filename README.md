# Divergent

Playlists built around music, not habits.

Most recommendation engines circle back to the artists you already play.
Divergent starts from the sound instead — a genre, a style, a mood — and caps
how often any one artist can appear. It also introduces you to a single artist
properly: their best-known tracks, their deep cuts, or a blend that places them
among artists who share their sound.

Every playlist exports to Spotify, Apple Music, YouTube Music and 40+ other
services, or downloads as CSV, M3U or plain text.

## Getting started

```bash
npm install
```

Copy the environment template and set a contact address — MusicBrainz requires
one in the User-Agent of every request and throttles anonymous callers:

```bash
cp .env.example .env.local
```

Create the database:

```bash
npm run db:migrate
```

Then:

```bash
npm run dev
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on http://localhost:3000 |
| `npm test` | Unit tests (no network access required) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate a migration after editing `src/lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:studio` | Browse the database |
| `npm run seed:genres` | Load the MusicBrainz genre list into the tag table |
| `npm run seed:demo` | Warm the cache for a few artists and tags |
| `npm run purge:noncommercial` | Report non-commercially-licensed rows (add `-- --apply` to delete) |

## Architecture

Three boundaries carry most of the design:

**The generation engine is pure.** `src/lib/engine/` imports nothing from
`providers/`, `db/` or `net/`. It receives an assembled pool of artists and
tracks and returns an ordered playlist. That is what makes the selection
algorithm testable without a network, and it means a data source can be
replaced without touching generation logic.

**Every data point records its source and licence.** Rows in `artist_tags`,
`similar_artists`, `popularity` and `external_ids` carry `source`,
`license_class` and `fetched_at`. See "Licensing" below for why.

**MusicBrainz IDs are the canonical spine.** Artists, releases and recordings
are keyed by MBID, with ISRCs stored on recordings for cross-platform matching.
Everything else — Deezer ids, Spotify ids — hangs off that.

### Why a single long-lived process

`next.config.ts` sets `output: 'standalone'` and the app must be deployed as one
persistent Node server, not to a serverless platform. Three reasons, all
load-bearing:

- MusicBrainz allows **1 request per second per IP**. The rate limiters in
  `src/lib/net/rateLimiter.ts` are module-scoped queues; parallel serverless
  instances would each believe they own the full budget and get the app blocked.
- Playlist generation runs as a background job in-process.
- SQLite needs a persistent disk.

A GCP Compute Engine `e2-micro` (free tier) is sufficient. Build elsewhere and
deploy the standalone output — 1 GB of RAM is not enough to run `next build`.

### Data sources

| Source | Used for | Licence |
| --- | --- | --- |
| MusicBrainz | Artists, releases, recordings, ISRCs | CC0 |
| MusicBrainz | Genres and tags | CC BY-NC-SA |
| ListenBrainz Labs | Similar artists, related tags, cross-platform ids | CC0 |
| Deezer | Track popularity — the hits-vs-deep-cuts signal | Non-commercial |
| Soundiiz | Playlist handoff to streaming services | See below |

Spotify's Web API is deliberately not used. Since February 2026 it caps
third-party apps at five authenticated users, requires the app owner to hold
Premium, and has removed recommendations, related artists, audio features and
artist top tracks. Extended access requires a registered business with roughly
250,000 monthly active users. The Soundiiz handoff reaches Spotify without any
of that, because the transfer runs on the user's own Soundiiz session.

## Licensing

The app runs today on free data sources, several of which are non-commercial.
Going commercial is a deliberate, scripted transition rather than a rewrite:

1. `npm run purge:noncommercial -- --apply` deletes every row whose
   `license_class` is `noncommercial` — Deezer popularity, Last.fm data, and
   MusicBrainz tags. Playlists survive: `playlist_tracks` stores a denormalised
   snapshot, so exports keep working.
2. Take a **MetaBrainz supporter tier** (Bronze, ~$100/mo) to license the
   MusicBrainz genre and tag data, then set
   `METABRAINZ_COMMERCIAL_LICENSE=true` so new tag rows are written as
   `licensed`. Contact them about the Stealth tier *before* launching — it is
   designed for the pre-launch phase and leads into Bronze cleanly.
3. Add **Soundcharts** (~$50/mo, self-serve) as the popularity provider,
   replacing Deezer, by implementing `PopularityProvider` in
   `src/lib/providers/`. No other code changes.
4. Confirm commercial use of the Soundiiz import endpoint with them in writing.
   It is currently unauthenticated with unpublished terms.

Estimated licensing cost at commercial launch: **~$150/month**.

Avoid: Last.fm's commercial agreement (it reserves an unpriced share of your
revenue), TIDAL's developer platform (non-commercial, and it explicitly
prohibits apps that transfer data to another service), and the Discogs API at
runtime (a six-hour freshness cap makes a precomputed index impossible — use
their CC0 monthly dumps instead).
