"use client";

import type { ObscurityBand } from "@/lib/engine/types";

interface Option {
  id: ObscurityBand;
  label: string;
  description: string;
}

/**
 * The setting means different things in different modes, and saying the wrong
 * one is worse than saying nothing: in most modes it picks how deep into an
 * artist's catalogue to go, while discovery uses it to pick how well-known the
 * artists themselves are.
 */
const VARIANTS: Record<"tracks" | "artists", Option[]> = {
  tracks: [
    {
      id: "easy",
      label: "Familiar",
      description: "The well-known stuff — an easy way in.",
    },
    {
      id: "medium",
      label: "Balanced",
      description: "Past the singles, but not obscure for its own sake.",
    },
    {
      id: "hard",
      label: "Off the map",
      description: "The tail end of the catalogue. Expect to recognise nothing.",
    },
  ],
  artists: [
    {
      id: "easy",
      label: "Familiar",
      description: "Big names you have probably heard of already.",
    },
    {
      id: "medium",
      label: "Balanced",
      description: "Mostly artists you have missed, with a few you know.",
    },
    {
      id: "hard",
      label: "Off the map",
      description: "The smallest artists that still fit. Expect to know none of them.",
    },
  ],
};

export function ObscurityPicker({
  value,
  onChange,
  label = "How deep should we dig?",
  variant = "tracks",
}: {
  value: ObscurityBand;
  onChange: (value: ObscurityBand) => void;
  /** Discovery asks the same question about artists rather than tracks. */
  label?: string;
  variant?: "tracks" | "artists";
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {VARIANTS[variant].map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            aria-pressed={value === option.id}
            className={`rounded-xl border p-4 text-left transition-colors ${
              value === option.id
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
  );
}
