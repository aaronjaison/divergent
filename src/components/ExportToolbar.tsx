"use client";

import { useState } from "react";

interface Props {
  playlistId: string;
  trackCount: number;
}

interface Handoff {
  shareUrl: string;
  expiresAt: number;
}

export function ExportToolbar({ playlistId, trackCount }: Props) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendToServices() {
    setPending(true);
    setError(null);
    try {
      // Requested on click, never ahead of time: Soundiiz links live ~24h.
      const response = await fetch(
        `/api/playlists/${playlistId}/export/soundiiz`,
        { method: "POST" },
      );
      const body = (await response.json()) as Partial<Handoff> & { error?: string };

      if (!response.ok || !body.shareUrl) {
        setError(body.error ?? "Could not create the transfer link.");
        return;
      }
      setHandoff({ shareUrl: body.shareUrl, expiresAt: body.expiresAt ?? 0 });
      window.open(body.shareUrl, "_blank", "noopener,noreferrer");
    } catch {
      setError("Could not reach the server. You can still download the playlist.");
    } finally {
      setPending(false);
    }
  }

  const disabled = pending || trackCount === 0;

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        Take it with you
      </h2>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={sendToServices}
          disabled={disabled}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? "Preparing…" : "Send to Spotify, Apple Music & more"}
        </button>

        <div className="flex gap-2 text-sm">
          {(["csv", "txt", "m3u"] as const).map((format) => (
            <a
              key={format}
              href={`/api/playlists/${playlistId}/export?format=${format}`}
              className="rounded-lg border border-border px-3 py-2 transition-colors hover:border-accent"
            >
              {format.toUpperCase()}
            </a>
          ))}
        </div>
      </div>

      {handoff && (
        <p className="mt-3 text-sm text-muted">
          Opened a transfer page in a new tab.{" "}
          <a
            className="underline hover:text-foreground"
            href={handoff.shareUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open it again
          </a>{" "}
          — the link expires in about 24 hours.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      <p className="mt-3 text-xs text-muted">
        Transfers run through Soundiiz, which connects to your streaming account
        directly. This app never sees your streaming login.
      </p>
    </div>
  );
}
