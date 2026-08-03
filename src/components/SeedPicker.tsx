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
  /**
   * Set once a search has been outstanding long enough to look broken.
   *
   * MusicBrainz's search latency is not something this app can fix — the same
   * query measured 0.2s one minute and 20s the next — so the honest thing is to
   * say which of the two is happening rather than showing "Searching…" for
   * twenty seconds and letting it read as a hang.
   */
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  /**
   * Answers already received this session, keyed by query.
   *
   * Backspacing is the commonest thing anyone does in a search box, and without
   * this every character removed is another rate-limited round trip for a
   * result we were showing a second ago.
   */
  const answered = useRef(new Map<string, T[]>());

  const full = selected.length >= max;

  useEffect(() => {
    const term = query.trim().toLowerCase();
    if (term.length < 2 || full) return;

    const cached = answered.current.get(term);
    if (cached) {
      setResults(cached);
      setLoading(false);
      setError(null);
      return;
    }

    // Debounced for the same reason as ArtistSearch: MusicBrainz allows one
    // request per second, so a request per keystroke queues up behind itself.
    const handle = setTimeout(async () => {
      const id = ++requestId.current;

      // Cancelling matters more than it looks. A MusicBrainz search waits its
      // turn in a one-per-second queue and then takes anywhere from a fifth of
      // a second to twenty to answer, so the searches typed past — and they are
      // the majority — sit in front of the one that is actually wanted, and it
      // waits out all of their responses. The abort reaches the server, which
      // skips the round trip when the query's turn comes up.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      setLoading(true);
      setSlow(false);
      setError(null);
      const slowTimer = setTimeout(() => {
        if (id === requestId.current) setSlow(true);
      }, 2_500);
      try {
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        const body = (await response.json()) as Record<string, unknown>;
        if (id !== requestId.current) return;

        if (!response.ok) {
          setError((body.error as string) ?? "Search failed.");
          setResults([]);
          return;
        }
        const found = (body[resultsKey] as T[]) ?? [];
        answered.current.set(term, found);
        setResults(found);
      } catch (cause) {
        // An abort is this component superseding itself, not a failure.
        if ((cause as Error)?.name === "AbortError") return;
        if (id === requestId.current) setError("Could not reach the server.");
      } finally {
        clearTimeout(slowTimer);
        if (id === requestId.current) {
          setLoading(false);
          setSlow(false);
        }
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
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-accent bg-accent-wash">
          {selected.map((item, index) => (
            <li
              key={identify(item)}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {String(index + 1).padStart(2, "0")}{" "}
                  </span>
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
          className="mt-3 w-full field"
        />
      )}

      {loading && (
        <p className="mt-2 text-sm text-muted">
          {slow
            ? "Still searching — the MusicBrainz index is slow right now. Results are cached once they arrive."
            : "Searching…"}
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}

      {/* Results stay on screen while the next search runs, rather than
          blanking: a MusicBrainz search can take several seconds, and an empty
          list in the meantime reads as "nothing found". */}
      {!full && results.length > 0 && (
        <ul
          className={`mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface transition-opacity ${
            loading ? "opacity-50" : ""
          }`}
        >
          {results
            .filter((item) => !chosenIds.has(identify(item)))
            .map((item) => (
              <li key={identify(item)}>
                <button
                  type="button"
                  onClick={() => add(item)}
                  className="w-full px-4 py-3 text-left transition-colors hover:bg-surface-sunken"
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
