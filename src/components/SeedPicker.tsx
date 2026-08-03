"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Multi-select search for playlist seeds.
 *
 * Shared by songs and albums because the interaction is identical and the only
 * real differences are how a result is labelled and how many you may pick.
 */

export interface TrackSeed {
  /**
   * Every recording id MusicBrainz has for this song, best first — see
   * ScoredRecordingRef. The similarity index knows some of them and not others,
   * and which is only discoverable by asking, so they all travel together.
   */
  mbids: string[];
  title: string;
  artistNames: string[];
  artistMbid?: string;
  album?: string;
  albumMbid?: string;
  year?: number;
  durationMs?: number;
}

export interface AlbumSeed {
  mbid: string;
  title: string;
  artistNames: string[];
  artistMbid?: string;
  year?: number;
  primaryType?: string;
}

interface Props<T> {
  label: string;
  placeholder: string;
  /** Most seeds allowed. Five for songs, three for albums. */
  max: number;
  endpoint: string;
  /** Key the endpoint returns its array under. */
  resultsKey: string;
  selected: T[];
  onChange: (next: T[]) => void;
  /** Stable identity, for dedupe and React keys. */
  identify: (item: T) => string;
  primaryText: (item: T) => string;
  secondaryText: (item: T) => string;
  emptyMessage: string;
}

export function SeedPicker<T>({
  label,
  placeholder,
  max,
  endpoint,
  resultsKey,
  selected,
  onChange,
  identify,
  primaryText,
  secondaryText,
  emptyMessage,
}: Props<T>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const full = selected.length >= max;

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || full) return;

    // Debounced for the same reason as ArtistSearch: MusicBrainz allows one
    // request per second, so a request per keystroke queues up behind itself.
    const handle = setTimeout(async () => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(term)}`);
        const body = (await response.json()) as Record<string, unknown>;
        if (id !== requestId.current) return;

        if (!response.ok) {
          setError((body.error as string) ?? "Search failed.");
          setResults([]);
          return;
        }
        setResults((body[resultsKey] as T[]) ?? []);
      } catch {
        if (id === requestId.current) setError("Could not reach the server.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 350);

    return () => clearTimeout(handle);
  }, [query, endpoint, resultsKey, full]);

  function add(item: T) {
    if (full) return;
    const id = identify(item);
    if (selected.some((existing) => identify(existing) === id)) return;
    onChange([...selected, item]);
    setQuery("");
    setResults([]);
  }

  function remove(item: T) {
    const id = identify(item);
    onChange(selected.filter((existing) => identify(existing) !== id));
  }

  const chosenIds = new Set(selected.map(identify));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={`seed-${resultsKey}`} className="block text-sm font-medium">
          {label}
        </label>
        <span className="text-xs text-muted">
          {selected.length} of {max}
        </span>
      </div>

      {selected.length > 0 && (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-accent">
          {selected.map((item, index) => (
            <li
              key={identify(item)}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  <span className="text-muted tabular-nums">{index + 1}. </span>
                  {primaryText(item)}
                </div>
                <div className="truncate text-sm text-muted">{secondaryText(item)}</div>
              </div>
              <button
                type="button"
                onClick={() => remove(item)}
                className="shrink-0 text-sm text-muted underline hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {!full && (
        <input
          id={`seed-${resultsKey}`}
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
          placeholder={placeholder}
          autoComplete="off"
          className="mt-3 w-full rounded-lg border border-border bg-surface px-4 py-2.5 outline-none focus:border-accent"
        />
      )}

      {loading && <p className="mt-2 text-sm text-muted">Searching…</p>}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      {!full && results.length > 0 && (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {results
            .filter((item) => !chosenIds.has(identify(item)))
            .map((item) => (
              <li key={identify(item)}>
                <button
                  type="button"
                  onClick={() => add(item)}
                  className="w-full px-4 py-3 text-left transition-colors hover:bg-border/40"
                >
                  <div className="font-medium">{primaryText(item)}</div>
                  <div className="text-sm text-muted">{secondaryText(item)}</div>
                </button>
              </li>
            ))}
        </ul>
      )}

      {!full && !loading && !error && query.trim().length >= 2 && results.length === 0 && (
        <p className="mt-2 text-sm text-muted">{emptyMessage}</p>
      )}
    </div>
  );
}
