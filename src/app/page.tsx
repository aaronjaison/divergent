import Link from "next/link";
import { listPlaylistsForSession } from "@/lib/db/repo/playlists";
import { readSessionId } from "@/lib/session/anonSession";

export const dynamic = "force-dynamic";

/**
 * Ordered and coloured to match the header — see MODES in SiteNav. The hue is
 * the only thing distinguishing the four cards, so it has to be the same hue in
 * both places or it identifies nothing.
 */
const MODES = [
  {
    href: "/builder",
    hue: "var(--hue-style)",
    title: "Build by style",
    body: "Pick genres, styles or moods and set how far off the beaten path you want to go. No artist appears more than twice.",
  },
  {
    href: "/introduce",
    hue: "var(--hue-artist)",
    title: "Introduce me to an artist",
    body: "Three ways in: the tracks everyone knows, the deep cuts that reward a second listen, or a blend with artists who share their sound.",
  },
  {
    href: "/discover",
    hue: "var(--hue-similar)",
    title: "Discover similar artists",
    body: "Name an artist you love and hear everyone else who sounds like them — one track each, and never the artist you named.",
  },
  {
    href: "/sounds-like",
    hue: "var(--hue-match)",
    title: "Find music like this",
    body: "Name up to five songs or three albums. We work out what they have in common and build from that — the more you name, the sharper it gets.",
  },
] as const;

export default async function Home() {
  const sessionId = await readSessionId();
  const recent = sessionId ? listPlaylistsForSession(sessionId, 5) : [];

  return (
    <div className="flex flex-col gap-16">
      <section className="max-w-3xl">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Playlists for people who have heard their recommendations already
        </p>
        <h1 className="font-display mt-4 text-5xl text-balance sm:text-6xl">
          Built around the music,{" "}
          {/* Broken by hand only where there is room for it; on a phone the
              forced break made a four-line headline out of a two-line one. */}
          <span className="sm:block">not around your habits.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted text-pretty">
          Most recommendations circle back to the artists you already play.
          Divergent starts from the sound instead — a genre, a record, a mood —
          and caps how often any one artist can appear.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {MODES.map((mode, index) => (
          <Link
            key={mode.href}
            href={mode.href}
            className="tile group flex flex-col p-6"
            style={{ "--tile-hue": mode.hue } as React.CSSProperties}
          >
            <div className="flex items-center gap-2.5">
              <span className="mode-dot" />
              <span className="font-mono text-xs text-muted tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
            </div>
            <h2 className="font-display mt-4 text-2xl">{mode.title}</h2>
            <p className="mt-2 text-sm text-muted text-pretty">{mode.body}</p>
            <span
              className="mt-5 text-sm font-medium opacity-0 transition-opacity group-hover:opacity-100"
              style={{ color: mode.hue }}
              aria-hidden="true"
            >
              Start →
            </span>
          </Link>
        ))}
      </section>

      {recent.length > 0 && (
        <section>
          <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
            Your recent playlists
          </h2>
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {recent.map((playlist) => (
              <li key={playlist.id}>
                <Link
                  href={`/playlist/${playlist.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface-sunken"
                >
                  <span className="truncate font-medium">{playlist.title}</span>
                  <span className="shrink-0 text-sm text-muted">
                    {playlist.status === "building" ? "building…" : playlist.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface-sunken p-6">
        <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
          Take it with you
        </h2>
        <p className="mt-3 max-w-2xl text-sm text-muted text-pretty">
          Every playlist exports to Spotify, Apple Music, YouTube Music and 40+
          other services through a one-click handoff, or downloads as CSV, M3U
          or plain text.
        </p>
      </section>
    </div>
  );
}
