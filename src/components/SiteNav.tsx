"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The four ways in, each carrying its own colour.
 *
 * A client component only so it can mark where you are: with four modes that
 * all produce a playlist, the header is the only thing on the page that says
 * which one you are using.
 */
export const MODES = [
  { href: "/builder", label: "Build by style", hue: "var(--hue-style)" },
  { href: "/introduce", label: "Introduce me", hue: "var(--hue-artist)" },
  { href: "/discover", label: "Similar artists", hue: "var(--hue-similar)" },
  { href: "/sounds-like", label: "Music like this", hue: "var(--hue-match)" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
      <Link href="/" className="font-display text-2xl tracking-tight">
        Divergent
        <span
          className="ml-0.5 inline-block size-1.5 rounded-full align-middle"
          style={{ background: "var(--hue-match)" }}
        />
      </Link>

      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
        {MODES.map((mode) => {
          const active = pathname === mode.href;
          return (
            <Link
              key={mode.href}
              href={mode.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors ${
                active
                  ? "bg-surface text-foreground"
                  : "text-muted hover:bg-surface hover:text-foreground"
              }`}
            >
              <span
                className="size-1.5 rounded-full transition-opacity"
                style={{ background: mode.hue, opacity: active ? 1 : 0.45 }}
              />
              {mode.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
