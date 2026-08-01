import { finishPlaylist, updateProgress } from "@/lib/db/repo/playlists";

/**
 * In-process job runner for playlist generation.
 *
 * A cold generation makes dozens of rate-limited calls and can take 30-60
 * seconds, which is far too long to hold an HTTP request open. So POST
 * /api/playlists returns an id immediately and the client polls.
 *
 * The database `status` column is the source of truth, not this map: after a
 * restart an interrupted playlist must read as failed rather than hang on
 * "building" forever.
 */

interface JobState {
  playlistId: string;
  startedAt: number;
  promise: Promise<void>;
}

const jobs = new Map<string, JobState>();

/** Generations are capped so one user cannot monopolise the provider queues. */
const MAX_CONCURRENT = 3;

export class TooManyJobsError extends Error {
  constructor() {
    super("Too many playlists are being built right now. Try again in a moment.");
    this.name = "TooManyJobsError";
  }
}

export interface JobContext {
  /** Reports progress to the polling client. */
  progress(done: number, total: number, label?: string): void;
}

export function activeJobCount(): number {
  return jobs.size;
}

export function isRunning(playlistId: string): boolean {
  return jobs.has(playlistId);
}

/**
 * Starts a generation in the background. The returned promise is for tests;
 * request handlers deliberately do not await it.
 */
export function startJob(
  playlistId: string,
  run: (ctx: JobContext) => Promise<{ warnings: string[]; trackCount: number }>,
): Promise<void> {
  if (jobs.has(playlistId)) return jobs.get(playlistId)!.promise;
  if (jobs.size >= MAX_CONCURRENT) throw new TooManyJobsError();

  const context: JobContext = {
    progress(done, total, label) {
      updateProgress(playlistId, { done, total, label });
    },
  };

  const promise = (async () => {
    try {
      const result = await run(context);
      // "partial" is a real outcome, not a failure: a short playlist with an
      // explanation beats an error page.
      finishPlaylist(
        playlistId,
        result.trackCount === 0 ? "failed" : result.warnings.length ? "partial" : "ready",
        result.warnings,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Playlist generation failed.";
      finishPlaylist(playlistId, "failed", [message]);
    } finally {
      jobs.delete(playlistId);
    }
  })();

  jobs.set(playlistId, { playlistId, startedAt: Date.now(), promise });
  return promise;
}

/** Test helper: waits for a specific job, or all of them. */
export async function waitForJobs(playlistId?: string): Promise<void> {
  if (playlistId) {
    await jobs.get(playlistId)?.promise;
    return;
  }
  await Promise.all([...jobs.values()].map((job) => job.promise));
}
