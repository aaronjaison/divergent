"use client";

import { MAX_PLAYLIST_LENGTH } from "@/lib/engine/types";

interface Props {
  value: number;
  onChange: (length: number) => void;
  label?: string;
}

/** Round numbers to jump to, so 200 is one click rather than 38 drags. */
const PRESETS = [25, 50, 100, MAX_PLAYLIST_LENGTH];

export function LengthPicker({ value, onChange, label = "Length" }: Props) {
  return (
    <div>
      <label htmlFor="length" className="block text-sm font-medium">
        {label}: {value} tracks
      </label>

      <input
        id="length"
        type="range"
        min={10}
        max={MAX_PLAYLIST_LENGTH}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-2 w-full accent-[var(--accent)]"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            aria-pressed={value === preset}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              value === preset
                ? "border-accent bg-surface"
                : "border-border hover:border-accent/50"
            }`}
          >
            {preset}
          </button>
        ))}
      </div>

      {value > 100 && (
        <p className="mt-2 text-xs text-muted">
          Long playlists take longer to build the first time — up to a couple of
          minutes while the music data is fetched and cached.
        </p>
      )}
    </div>
  );
}
