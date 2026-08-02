"use client";

import { useState } from "react";

interface PlatformLink {
  platform: string;
  label: string;
  url: string;
}

/**
 * Per-track "listen on" links, fetched on click rather than with the playlist.
 * The lookup service allows about 10 requests a minute, so resolving 25 tracks
 * up front would take longer than the playlist took to build.
 */
export function TrackLinks({ isrc }: { isrc: string | null }) {
  const [links, setLinks] = useState<PlatformLink[] | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!isrc) return null;

  async function load() {
    if (links || pending) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/tracks/links?isrc=${encodeURIComponent(isrc as string)}`);
      const body = (await response.json()) as {
        links?: PlatformLink[];
        error?: string;
      };
      if (!response.ok) {
        setMessage(body.error ?? "Could not find links.");
        return;
      }
      if (!body.links?.length) {
        setMessage("No matches found on other services.");
        return;
      }
      setLinks(body.links);
    } catch {
      setMessage("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  if (links) {
    return (
      <div className="mt-1 flex flex-wrap gap-2">
        {links.map((link) => (
          <a
            key={link.platform}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline text-muted hover:text-foreground"
          >
            {link.label}
          </a>
        ))}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={load}
      disabled={pending}
      className="mt-1 text-xs text-muted underline hover:text-foreground disabled:opacity-50"
    >
      {pending ? "Finding…" : (message ?? "Listen on…")}
    </button>
  );
}
