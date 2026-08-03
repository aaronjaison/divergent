"use client";

import { useEffect, useRef, useState } from "react";

export interface ArtistResult {
  mbid: string;
  name: string;
  disambiguation?: string;
  country?: string;
  beginYear?: number;
  endYear?: number;
}

interface Props {
  onSelect: (artist: ArtistResult) => void;
  selected: ArtistResult | null;
  label?: string;
}

/** Describes an artist enough to tell two same-named acts apart. */
function subtitle(artist: ArtistResult): string {
  const parts: string[] = [];
  if (artist.disambiguation) parts.push(artist.disambiguation);
  if (artist.country) parts.push(artist.country);
  if (artist.beginYear) {
    parts.push(`${artist.beginYear}–${artist.endYear ?? ""}`);
  }
  return parts.join(" · ");
}

export function ArtistSearch({
  onSelect,
  selected,
  label = "Which artist?",
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ArtistResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    // Clearing happens in the change handler; an effect that sets state
    // synchronously would cascade a second render on every keystroke.
    if (term.length < 2) return;

    // Debounced: MusicBrainz allows one request per second, so firing on every
    // keystroke would queue up behind itself and feel broken.
    const handle = setTimeout(async () => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/search/artists?q=${encodeURIComponent(term)}`,
        );
        const body = (await response.json()) as {
          artists?: ArtistResult[];
          error?: string;
        };
        // Ignore a response that a newer keystroke has superseded.
        if (id !== requestId.current) return;

        if (!response.ok) {
          setError(body.error ?? "Search failed.");
          setResults([]);
          return;
        }
        setResults(body.artists ?? []);
      } catch {
        if (id === requestId.current) setError("Could not reach the server.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 350);

    return () => clearTimeout(handle);
  }, [query]);

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-accent bg-surface px-4 py-3">
        <div>
          <div className="font-medium">{selected.name}</div>
          {subtitle(selected) && (
            <div className="text-sm text-muted">{subtitle(selected)}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setQuery("");
            setResults([]);
            onSelect({ mbid: "", name: "" });
          }}
          className="text-sm text-muted underline hover:text-foreground"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="artist-search" className="block text-sm font-medium">
        {label}
      </label>
      <input
        id="artist-search"
        type="search"
        value={query}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          if (next.trim().length < 2) {
            setResults([]);
            setError(null);
          }
        }}
        placeholder="Start typing an artist name…"
        autoComplete="off"
        className="mt-2 w-full field"
      />

      {loading && <p className="mt-2 text-sm text-muted">Searching…</p>}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      {results.length > 0 && (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {results.map((artist) => (
            <li key={artist.mbid}>
              <button
                type="button"
                onClick={() => onSelect(artist)}
                className="w-full px-4 py-3 text-left transition-colors hover:bg-border/40"
              >
                <div className="font-medium">{artist.name}</div>
                {subtitle(artist) && (
                  <div className="text-sm text-muted">{subtitle(artist)}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && query.trim().length >= 2 && results.length === 0 && (
        <p className="mt-2 text-sm text-muted">No artists found.</p>
      )}
    </div>
  );
}
