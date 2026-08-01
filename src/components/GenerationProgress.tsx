"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  playlistId: string;
  initialLabel: string | null;
  initialDone: number;
  initialTotal: number;
}

interface StatusResponse {
  status: "building" | "ready" | "partial" | "failed";
  progress: { done: number; total: number; label: string | null };
}

/**
 * Polls while a playlist is being built. Cold generations take 30-60 seconds
 * because MusicBrainz allows one request per second, so showing real progress
 * matters more here than it would for a fast endpoint.
 */
export function GenerationProgress({
  playlistId,
  initialLabel,
  initialDone,
  initialTotal,
}: Props) {
  const router = useRouter();
  const [label, setLabel] = useState(initialLabel);
  const [done, setDone] = useState(initialDone);
  const [total, setTotal] = useState(initialTotal);

  useEffect(() => {
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/playlists/${playlistId}`);
        if (!response.ok) return;
        const body = (await response.json()) as StatusResponse;
        if (cancelled) return;

        setLabel(body.progress.label);
        setDone(body.progress.done);
        setTotal(body.progress.total);

        if (body.status !== "building") {
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        // A dropped poll is not worth surfacing; the next tick retries.
      }
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [playlistId, router]);

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="rounded-xl border border-border bg-surface p-6">
      <div className="flex items-center gap-3">
        <span className="size-2 animate-pulse rounded-full bg-accent" />
        <p className="text-sm font-medium">
          {label ?? "Building your playlist…"}
        </p>
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>

      <p className="mt-3 text-xs text-muted">
        {total > 0 ? `${done} of ${total}. ` : ""}
        Looking up music data can take up to a minute the first time — results
        are cached, so the next one is quick.
      </p>
    </div>
  );
}
