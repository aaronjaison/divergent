"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArtistSearch, type ArtistResult } from "./ArtistSearch";
import { LengthPicker } from "./LengthPicker";
import { ObscurityPicker } from "./ObscurityPicker";
import type { ObscurityBand } from "@/lib/engine/types";

type Mode = "famous" | "deep" | "blend";

const MODES: { id: Mode; title: string; description: string }[] = [
  {
    id: "famous",
    title: "The essentials",
    description: "Their best-known tracks — the ones most people start with.",
  },
  {
    id: "deep",
    title: "Deep cuts",
    description:
      "Album tracks that never became singles, in release order so it plays like a career.",
  },
  {
    id: "blend",
    title: "Blend with similar artists",
    description:
      "Hear them alongside artists who share their sound, rather than in isolation.",
  },
];

export function IntroduceForm() {
  const router = useRouter();
  const [artist, setArtist] = useState<ArtistResult | null>(null);
  const [mode, setMode] = useState<Mode>("famous");
  const [obscurity, setObscurity] = useState<ObscurityBand>("medium");
  const [length, setLength] = useState(20);
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
          mode: "introduce",
          submode: mode,
          artistMbid: artist.mbid,
          artistName: artist.name,
          constraints: {
            targetLength: length,
            // The blend's obscurity setting applies to every artist in it;
            // "famous" ignores it by definition.
            obscurity: mode === "famous" ? "easy" : obscurity,
          },
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
      />

      {artist?.mbid && (
        <>
          <fieldset>
            <legend className="text-sm font-medium">How do you want to meet them?</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {MODES.map((option) => (
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
                  <div className="font-medium">{option.title}</div>
                  <div className="mt-1 text-sm text-muted">{option.description}</div>
                </button>
              ))}
            </div>
          </fieldset>

          {mode !== "famous" && (
            <ObscurityPicker value={obscurity} onChange={setObscurity} />
          )}

          <LengthPicker
            value={length}
            onChange={setLength}
            label="Playlist length"
          />

          <div>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Starting…" : `Introduce me to ${artist.name}`}
            </button>
            {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
