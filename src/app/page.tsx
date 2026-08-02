import Link from "next/link";
import { listPlaylistsForSession } from "@/lib/db/repo/playlists";
import { readSessionId } from "@/lib/session/anonSession";

export const dynamic = "force-dynamic";

export default async function Home() {
  const sessionId = await readSessionId();
  const recent = sessionId ? listPlaylistsForSession(sessionId, 5) : [];

  return (
    <div className="flex flex-col gap-12">
      <section className="max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Playlists built around music, not habits.
        </h1>
        <p className="mt-4 text-lg text-muted text-pretty">
          Most recommendations circle back to the artists you already play.
          Divergent starts from the sound instead — a genre, a style, a mood —
          and caps how often any one artist can appear.
        </p>
      </section>

      <section className="grid gap-5 sm:grid-cols-2">
        <Link
          href="/builder"
          className="group rounded-xl border border-border bg-surface p-6 transition-colors hover:border-accent"
        >
          <h2 className="text-xl font-medium group-hover:text-accent">
            Build by style
          </h2>
          <p className="mt-2 text-sm text-muted">
            Pick genres, styles or moods and set how far off the beaten path you
            want to go. No artist appears more than twice.
          </p>
        </Link>

        <Link
          href="/introduce"
          className="group rounded-xl border border-border bg-surface p-6 transition-colors hover:border-accent"
        >
          <h2 className="text-xl font-medium group-hover:text-accent">
            Introduce me to an artist
          </h2>
          <p className="mt-2 text-sm text-muted">
            Three ways in: the tracks everyone knows, the deep cuts that reward
            a second listen, or a blend with artists who share their sound.
          </p>
        </Link>
      </section>

      {recent.length > 0 && (
        <section>
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
            Your recent playlists
          </h2>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {recent.map((playlist) => (
              <li key={playlist.id}>
                <Link
                  href={`/playlist/${playlist.id}`}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-border/40"
                >
                  <span className="font-medium">{playlist.title}</span>
                  <span className="text-sm text-muted">
                    {playlist.status === "building" ? "building…" : playlist.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Take it with you
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Every playlist exports to Spotify, Apple Music, YouTube Music and 40+
          other services through a one-click handoff, or downloads as CSV, M3U
          or plain text.
        </p>
      </section>
    </div>
  );
}
