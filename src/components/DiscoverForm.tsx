"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArtistSearch, type ArtistResult } from "./ArtistSearch";
import { LengthPicker } from "./LengthPicker";
import { ObscurityPicker } from "./ObscurityPicker";
import type { ObscurityBand } from "@/lib/engine/types";

export function DiscoverForm() {
  const router = useRouter();
  const [artist, setArtist] = useState<ArtistResult | null>(null);
  const [obscurity, setObscurity] = useState<ObscurityBand>("medium");
  const [length, setLength] = useState(30);
  // Defaults to one apiece: the point of this mode is how many artists you
  // meet, not how much of any one of them you hear.
  const [maxPerArtist, setMaxPerArtist] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!artist?.mbid) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "discover",
          artistMbid: artist.mbid,
          artistName: artist.name,
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

  return (
    <div className="flex flex-col gap-8">
      <ArtistSearch
        selected={artist?.mbid ? artist : null}
        onSelect={(result) => setArtist(result.mbid ? result : null)}
        label="Which artist should we start from?"
      />

      {artist?.mbid && (
        <>
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-muted">
            {artist.name} will not appear in this playlist. Every track comes
            from someone else who sounds like them.
          </div>

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
                At most {maxPerArtist} track{maxPerArtist === 1 ? "" : "s"} per
                artist
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
              {submitting ? "Starting…" : `Find artists like ${artist.name}`}
            </button>
            {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
