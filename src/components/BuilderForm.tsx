"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LengthPicker } from "./LengthPicker";
import { ObscurityPicker } from "./ObscurityPicker";
import { TagPicker } from "./TagPicker";
import type { ObscurityBand } from "@/lib/engine/types";

const POPULAR = [
  "shoegaze",
  "dream pop",
  "post-punk",
  "krautrock",
  "boom bap",
  "cosmic jazz",
  "dub techno",
  "ambient",
  "afrobeat",
  "bossa nova",
];

export function BuilderForm() {
  const router = useRouter();
  const [tags, setTags] = useState<string[]>([]);
  const [obscurity, setObscurity] = useState<ObscurityBand>("medium");
  const [length, setLength] = useState(25);
  const [maxPerArtist, setMaxPerArtist] = useState(2);
  const [eraFrom, setEraFrom] = useState("");
  const [eraTo, setEraTo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (tags.length === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "style",
          tags: tags.map((tag) => ({ tag, weight: 1 })),
          constraints: {
            targetLength: length,
            maxPerArtist,
            obscurity,
            eraFrom: eraFrom ? Number(eraFrom) : undefined,
            eraTo: eraTo ? Number(eraTo) : undefined,
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
      <TagPicker selected={tags} onChange={setTags} popular={POPULAR} />

      {tags.length > 0 && (
        <>
          <ObscurityPicker value={obscurity} onChange={setObscurity} />

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
                max={4}
                step={1}
                value={maxPerArtist}
                onChange={(event) => setMaxPerArtist(Number(event.target.value))}
                className="mt-2 w-full accent-[var(--accent)]"
              />
              <p className="mt-1 text-xs text-muted">
                Lower means more artists and a wider net.
              </p>
            </div>
          </div>

          <fieldset>
            <legend className="text-sm font-medium">Era (optional)</legend>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="number"
                inputMode="numeric"
                placeholder="From"
                min={1900}
                max={2100}
                value={eraFrom}
                onChange={(event) => setEraFrom(event.target.value)}
                aria-label="Era from year"
                className="w-28 rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
              />
              <span className="text-muted">–</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="To"
                min={1900}
                max={2100}
                value={eraTo}
                onChange={(event) => setEraTo(event.target.value)}
                aria-label="Era to year"
                className="w-28 rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
              />
            </div>
          </fieldset>

          <div>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="btn-primary"
            >
              {submitting ? "Starting…" : "Build the playlist"}
            </button>
            {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}
