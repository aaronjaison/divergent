"use client";

import { useEffect, useRef, useState } from "react";

export interface TagSuggestion {
  name: string;
  kind?: string;
}

interface Props {
  selected: string[];
  onChange: (tags: string[]) => void;
  /** Shown as one-click starting points before the user types anything. */
  popular?: string[];
}

export function TagPicker({ selected, onChange, popular = [] }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const requestId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    // Cleared in the change handler instead: setting state synchronously in an
    // effect cascades an extra render on every keystroke.
    if (term.length < 2) return;

    const handle = setTimeout(async () => {
      const id = ++requestId.current;
      try {
        const response = await fetch(
          `/api/search/tags?q=${encodeURIComponent(term)}`,
        );
        const body = (await response.json()) as { tags?: TagSuggestion[] };
        if (id !== requestId.current) return;
        setSuggestions(body.tags ?? []);
      } catch {
        if (id === requestId.current) setSuggestions([]);
      }
    }, 250);

    return () => clearTimeout(handle);
  }, [query]);

  function add(tag: string) {
    const name = tag.trim().toLowerCase();
    if (!name || selected.includes(name)) return;
    onChange([...selected, name]);
    setQuery("");
    setSuggestions([]);
  }

  function remove(tag: string) {
    onChange(selected.filter((t) => t !== tag));
  }

  const unusedPopular = popular.filter((tag) => !selected.includes(tag));

  return (
    <div>
      <label htmlFor="tag-search" className="block text-sm font-medium">
        What should it sound like?
      </label>

      {selected.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {selected.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => remove(tag)}
                className="flex items-center gap-2 rounded-full border border-accent bg-surface px-3 py-1.5 text-sm"
                aria-label={`Remove ${tag}`}
              >
                {tag}
                <span aria-hidden className="text-muted">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        id="tag-search"
        type="search"
        value={query}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          if (next.trim().length < 2) setSuggestions([]);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            add(suggestions[0]?.name ?? query);
          }
        }}
        placeholder="shoegaze, dream pop, boom bap, cosmic jazz…"
        autoComplete="off"
        className="mt-3 w-full rounded-lg border border-border bg-surface px-4 py-2.5 outline-none focus:border-accent"
      />

      {suggestions.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {suggestions.map((tag) => (
            <li key={tag.name}>
              <button
                type="button"
                onClick={() => add(tag.name)}
                className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:border-accent"
              >
                {tag.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggestions.length === 0 && unusedPopular.length > 0 && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-muted">
            Try one of these
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {unusedPopular.map((tag) => (
              <li key={tag}>
                <button
                  type="button"
                  onClick={() => add(tag)}
                  className="rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:border-accent"
                >
                  {tag}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
