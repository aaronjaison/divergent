"use client";

import type { ObscurityBand } from "@/lib/engine/types";

const OPTIONS: { id: ObscurityBand; label: string; description: string }[] = [
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
];

export function ObscurityPicker({
  value,
  onChange,
}: {
  value: ObscurityBand;
  onChange: (value: ObscurityBand) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">How deep should we dig?</legend>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {OPTIONS.map((option) => (
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
