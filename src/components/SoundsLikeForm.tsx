"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LengthPicker } from "./LengthPicker";
import { ObscurityPicker } from "./ObscurityPicker";
import { SeedPicker, type AlbumSeed, type TrackSeed } from "./SeedPicker";
import type { ObscurityBand } from "@/lib/engine/types";

/**
 * Seeds are capped at five songs and three albums. Both are the point at which
 * another one stops changing the answer: the consensus profile is already
 * dominated by what the existing seeds share, and every extra seed costs a
 * rate-limited round of lookups before the playlist can start.
 */
export const MAX_TRACK_SEEDS = 5;
export const MAX_ALBUM_SEEDS = 3;

type Mode = "tracks" | "albums";

function joinArtists(names: string[]): string {
  return names.length > 0 ? names.join(", ") : "Unknown artist";
}

/**
 * Says what another seed would buy, in the same terms the algorithm works in.
 * The claim is real rather than encouraging noise: the profile is weighted by
 * how many seeds carry each tag, so a tag only one seed has is suppressed hard
 * once there are others to compare it against.
 */
function guidance(count: number, max: number, noun: string): string {
  if (count === 0) {
    return `Pick up to ${max} ${noun}s you want more music like.`;
  }
  if (count === 1) {
    return `One ${noun} tells us a genre. A second tells us which part of it you actually mean — the more you add, the more accurate the match gets.`;
  }
  if (count < max) {
    return `${count} ${noun}s. We build the playlist from what they have in common, so each one you add makes the match more accurate.`;
  }
  return `${max} ${noun}s — the most we use. The playlist will be built from whatever these share.`;
}

export function SoundsLikeForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("tracks");
  const [tracks, setTracks] = useState<TrackSeed[]>([]);
  const [albums, setAlbums] = useState<AlbumSeed[]>([]);
  const [obscurity, setObscurity] = useState<ObscurityBand>("medium");
  const [length, setLength] = useState(30);
  const [maxPerArtist, setMaxPerArtist] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = mode === "tracks" ? tracks.length : albums.length;
  const max = mode === "tracks" ? MAX_TRACK_SEEDS : MAX_ALBUM_SEEDS;
  const noun = mode === "tracks" ? "song" : "album";

  async function submit() {
    if (count === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "sounds-like",
          seedKind: mode,
          tracks: mode === "tracks" ? tracks : undefined,
          albums: mode === "albums" ? albums : undefined,
          constraints: { targetLength: length, maxPerArtist, obscurity },
        }),
      });

      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id) {
        setError(body.error ?? "Could not start the playlist.");
        return;
      }
      router.push(`/playlist/${body.id}`);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  const seedArtists = [
    ...new Set(
      (mode === "tracks" ? tracks : albums).flatMap((seed) => seed.artistNames),
    ),
  ];

  return (
    <div className="flex flex-col gap-8">
      <fieldset>
        <legend className="text-sm font-medium">Start from</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                id: "tracks" as const,
                label: "Songs",
                description: `Up to ${MAX_TRACK_SEEDS}. The most precise way in — a single track pins down a sound an artist name never could.`,
              },
              {
                id: "albums" as const,
                label: "Albums",
                description: `Up to ${MAX_ALBUM_SEEDS}. A record carries a mood across a whole tracklist, so fewer are needed.`,
              },
            ]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setMode(option.id)}
              aria-pressed={mode === option.id}
              className={`rounded-xl border p-4 text-left transition-colors ${
                mode === option.id
                  ? "border-accent bg-surface"
                  : "border-border hover:border-accent/50"
              }`}
            >
              <div className="font-medium">{option.label}</div>
              <div className="mt-1 text-sm text-muted">{option.description}</div>
            </button>
          ))}
        </div>
      </fieldset>

      {mode === "tracks" ? (
        <SeedPicker<TrackSeed>
          label="Which songs?"
          placeholder="Song and artist, e.g. karma police radiohead"
          max={MAX_TRACK_SEEDS}
          endpoint="/api/search/recordings"
          resultsKey="recordings"
          selected={tracks}
          onChange={setTracks}
          identify={(track) => track.mbids[0] ?? track.title}
          primaryText={(track) => track.title}
          secondaryText={(track) =>
            [joinArtists(track.artistNames), track.album, track.year]
              .filter(Boolean)
              .join(" · ")
          }
          emptyMessage="No songs found. Try adding the artist's name."
        />
      ) : (
        <SeedPicker<AlbumSeed>
          label="Which albums?"
          placeholder="Album and artist, e.g. loveless my bloody valentine"
          max={MAX_ALBUM_SEEDS}
          endpoint="/api/search/albums"
          resultsKey="albums"
          selected={albums}
          onChange={setAlbums}
          identify={(album) => album.mbid}
          primaryText={(album) => album.title}
          secondaryText={(album) =>
            [joinArtists(album.artistNames), album.year, album.primaryType]
              .filter(Boolean)
              .join(" · ")
          }
          emptyMessage="No albums found. Try adding the artist's name."
        />
      )}

      <div className="rounded-xl border border-border bg-surface p-4">
        <div
          className="flex gap-1.5"
          role="img"
          aria-label={`${count} of ${max} ${noun}s chosen`}
        >
          {Array.from({ length: max }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full ${
                i < count ? "bg-accent" : "bg-border"
              }`}
            />
          ))}
        </div>
        <p className="mt-3 text-sm text-muted text-pretty">
          {guidance(count, max, noun)}
        </p>
      </div>

      {count > 0 && (
        <>
          {seedArtists.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-4 text-sm text-muted text-pretty">
              {seedArtists.length === 1
                ? `${seedArtists[0]} will not appear in this playlist.`
                : `${seedArtists.slice(0, -1).join(", ")} and ${seedArtists.at(-1)} will not appear in this playlist.`}{" "}
              Every track comes from someone else who fits what you picked.
            </div>
          )}

          <ObscurityPicker
            value={obscurity}
            onChange={setObscurity}
            label="How far from the obvious?"
            variant="artists"
          />

          <div className="grid gap-6 sm:grid-cols-2">
            <LengthPicker value={length} onChange={setLength} />

            <div>
              <label htmlFor="max-per-artist" className="block text-sm font-medium">
                At most {maxPerArtist} track{maxPerArtist === 1 ? "" : "s"} per artist
              </label>
              <input
                id="max-per-artist"
                type="range"
                min={1}
                max={3}
                step={1}
                value={maxPerArtist}
                onChange={(event) => setMaxPerArtist(Number(event.target.value))}
                className="mt-2 w-full accent-[var(--accent)]"
              />
              <p className="mt-1 text-xs text-muted">
                {maxPerArtist === 1
                  ? `One each means ${length} different artists.`
                  : "Two or three gives you longer with each artist, and fewer of them."}
              </p>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting
                ? "Starting…"
                : `Find music like ${count === 1 ? `this ${noun}` : `these ${count} ${noun}s`}`}
            </button>
            {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
