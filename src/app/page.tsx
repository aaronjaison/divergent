import Link from "next/link";

export default function Home() {
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
