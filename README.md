# Divergent

Playlists built around music, not habits.

Most recommendation engines circle back to the artists you already play.
Divergent starts from the sound instead — a genre, a style, a mood — and caps
how often any one artist can appear.

Three ways in:

- **Build by style** (`/builder`) — pick genres, styles or moods and get a
  playlist assembled from artists who fit, with a hard cap on repeats.
- **Introduce me** (`/introduce`) — meet one artist properly: their best-known
  tracks, their deep cuts in release order, or a blend that places them among
  artists who share their sound.
- **Discover similar artists** (`/discover`) — name an artist you love and get a
  playlist of everyone *else* who sounds like them, one track each. The artist
  you named never appears; the point is how many new ones you meet.

Playlists run up to 200 tracks, which is the largest a Soundiiz handoff accepts.
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

### Playlist length and pool sizing

Playlists go up to `MAX_PLAYLIST_LENGTH` (200), set by Soundiiz's import
endpoint — building more would produce a playlist that cannot reach the service
it was made for.

The hard part of a long playlist is not the cap but filling it. Every pool is
therefore sized from the request rather than fixed, and deliberately overshoots,
because a meaningful share of any shortlist yields nothing once the popularity
provider fails to resolve an artist, title filters run, and cross-artist dedupe
happens. `artistsNeededFor` and the constants beside it in
`src/lib/services/playlistService.ts` are where that arithmetic lives.

Two consequences worth knowing:

- **Loading stops early.** Once the pool could fill the playlist `POOL_HEADROOM`
  times over, the service stops resolving artists. A well-resolving shortlist
  costs a fraction of its full length.
- **Discovery over-fetches on purpose.** The obscurity band works by pushing
  well-known artists down the order, which only removes anyone if there are more
  candidates than seats — hence `DISCOVERY_OVERSHOOT`.

Where a mode genuinely cannot reach the requested length — Radiohead has around
36 real deep cuts, not 80 — the playlist is marked `partial` and says so rather
than padding.

### Genre coherence: why ranks, not multipliers

Co-listening similarity answers "who else do these listeners play?", not "who
sounds like this?". Asked who is similar to Radiohead it truthfully returns Pink
Floyd, the Beatles and Led Zeppelin — all correct, and all useless to someone
looking for something new.

The first attempt at fixing this scaled similarity by genre overlap. It does not
work, and the measurements say so. Asked who is like PinkPantheress:

| Candidate | Co-listening similarity | Genre fit |
| --- | --- | --- |
| The Weeknd | 1.000 | 0.029 |
| Nia Archives (the right answer) | 0.223 | 0.294 |

Any multiplier leaves The Weeknd about three times higher, because a superstar's
co-listening score is an order of magnitude larger than an underground artist's
and a fractional penalty cannot close that gap. Roughly **half** of a typical
co-listening list scores exactly zero genre fit against the seed.

So `rankByGenreThenSimilarity` combines the two by **rank**, which is scale-free:
an artist first on genre and fiftieth on co-listening beats one first on
co-listening and fiftieth on genre. Four things build on that:

1. **Tag specificity** (`tagSpecificity`) — sharing "hip hop" is close to no
   evidence; sharing "trap metal" is strong evidence. Umbrella categories are
   discounted and non-genre tags ("2020s", "british", "seen live") are ignored.
   `alternative rock` counts as an umbrella: Radiohead, Train and The Fray all
   carry it.
2. **Coherence with the group, not just the seed** (`selectCoherent`) —
   similarity is not transitive. Both a drill artist and a breakbeat-pop one can
   be honest answers for a broad rap seed, and pairing them is still wrong.
   Selection is greedy against a moving centroid, so the playlist picks a lane
   and stays in it.
3. **A genre gate** — candidates with no measurable genre relationship are
   dropped outright, not down-weighted, unless that would leave too few to build
   from.
4. **Fame banding within the pool** (`buildDiscovery`) — how well-known an artist
   is *relative to the others who sound like this one* is the only comparison
   that means anything.

The payoff is the one worth having: filtering hard on genre is also what surfaces
the smaller artists, because the noise it removes is almost entirely famous.
PinkPantheress went from Maroon 5 and Harry Styles to Pola & Bryson, Technimatic,
Redeyes and Hybrid Minds.

Making this affordable needed `getTagProfiles`, which fetches genre profiles for
a hundred artists in two batched `arid:` searches rather than a hundred
one-per-second lookups. Genre checking used to be rationed to about two dozen
candidates; it is now total, and generation got faster.

Tag specificity is a curated tier list rather than a computed one. The principled
version is inverse document frequency over the tag corpus, which needs a
pre-seeded frequency table — the tiers capture most of the same effect because
the categories broad enough to mislead are a small, stable set.

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
