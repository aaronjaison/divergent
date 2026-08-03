import { NextResponse } from "next/server";
import { z } from "zod";
import { createPlaylist } from "@/lib/db/repo/playlists";
import { seedFromString } from "@/lib/engine/random";
import { DEFAULT_CONSTRAINTS, MAX_PLAYLIST_LENGTH } from "@/lib/engine/types";
import { getOrCreateSessionId } from "@/lib/session/anonSession";
import { startJob, TooManyJobsError } from "@/lib/services/generationJobs";
import {
  runDiscover,
  runIntroduce,
  runSoundsLike,
  runStyle,
} from "@/lib/services/playlistService";

const constraintsSchema = z.object({
  targetLength: z
    .number()
    .int()
    .min(5)
    .max(MAX_PLAYLIST_LENGTH)
    .default(DEFAULT_CONSTRAINTS.targetLength),
  maxPerArtist: z.number().int().min(1).max(5).default(DEFAULT_CONSTRAINTS.maxPerArtist),
  obscurity: z.enum(["easy", "medium", "hard"]).default(DEFAULT_CONSTRAINTS.obscurity),
  eraFrom: z.number().int().min(1900).max(2100).optional(),
  eraTo: z.number().int().min(1900).max(2100).optional(),
});

const styleSchema = z.object({
  mode: z.literal("style"),
  tags: z
    .array(z.object({ tag: z.string().min(1).max(60), weight: z.number().min(0).max(1) }))
    .min(1)
    .max(5),
  constraints: constraintsSchema.optional(),
});

const introduceSchema = z.object({
  mode: z.literal("introduce"),
  submode: z.enum(["famous", "deep", "blend"]),
  // MusicBrainz IDs are UUIDs; rejecting anything else keeps junk out of the
  // provider queues entirely.
  artistMbid: z.string().uuid(),
  artistName: z.string().min(1).max(200),
  constraints: constraintsSchema.optional(),
});

const discoverSchema = z.object({
  mode: z.literal("discover"),
  artistMbid: z.string().uuid(),
  artistName: z.string().min(1).max(200),
  constraints: constraintsSchema.optional(),
});

/**
 * Seeds arrive as whole search results rather than as bare ids, so generation
 * does not have to look each one up again to learn its title and artist. Zod
 * strips anything else the client sent: tags in particular are re-fetched
 * server-side, since a stale or edited profile would quietly steer the
 * consensus.
 */
const trackSeedSchema = z.object({
  mbids: z.array(z.string().uuid()).min(1).max(12),
  title: z.string().min(1).max(300),
  artistNames: z.array(z.string().min(1).max(200)).max(12),
  artistMbid: z.string().uuid().optional(),
  album: z.string().max(300).optional(),
  albumMbid: z.string().uuid().optional(),
  year: z.number().int().min(1000).max(2100).optional(),
});

const albumSeedSchema = z.object({
  mbid: z.string().uuid(),
  title: z.string().min(1).max(300),
  artistNames: z.array(z.string().min(1).max(200)).max(12),
  artistMbid: z.string().uuid().optional(),
  year: z.number().int().min(1000).max(2100).optional(),
});

/**
 * Five songs or three albums. Both caps are where another seed stops changing
 * the answer — the consensus is already dominated by what the existing picks
 * share — and every extra one costs a rate-limited round of lookups first.
 */
const soundsLikeSchema = z
  .object({
    mode: z.literal("sounds-like"),
    seedKind: z.enum(["tracks", "albums"]),
    tracks: z.array(trackSeedSchema).max(5).optional(),
    albums: z.array(albumSeedSchema).max(3).optional(),
    constraints: constraintsSchema.optional(),
  })
  .refine(
    (body) =>
      body.seedKind === "tracks"
        ? (body.tracks?.length ?? 0) > 0
        : (body.albums?.length ?? 0) > 0,
    { message: "Pick at least one song or album." },
  );

const bodySchema = z.discriminatedUnion("mode", [
  styleSchema,
  introduceSchema,
  discoverSchema,
  soundsLikeSchema,
]);

const SUBMODE_KIND = {
  famous: "introduce_famous",
  deep: "introduce_deep",
  blend: "introduce_blend",
} as const;

const SUBMODE_TITLE = {
  famous: (name: string) => `${name}: the essentials`,
  deep: (name: string) => `${name}: deep cuts`,
  blend: (name: string) => `${name} and friends`,
} as const;

/** Names the first pick and counts the rest — a title has to fit on one line. */
function soundsLikeTitle(body: z.infer<typeof soundsLikeSchema>): string {
  const picks =
    body.seedKind === "tracks"
      ? (body.tracks ?? []).map((track) => track.title)
      : (body.albums ?? []).map((album) => album.title);

  if (picks.length === 0) return "Music like this";
  if (picks.length === 1) return `Music like ${picks[0]}`;
  return `Music like ${picks[0]} + ${picks.length - 1} more`;
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Those options are not valid.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const sessionId = await getOrCreateSessionId();
  const body = parsed.data;
  const constraintValues = constraintsSchema.parse(body.constraints ?? {});

  if (
    constraintValues.eraFrom !== undefined &&
    constraintValues.eraTo !== undefined &&
    constraintValues.eraFrom > constraintValues.eraTo
  ) {
    return NextResponse.json(
      { error: "The era range starts after it ends." },
      { status: 400 },
    );
  }

  const title =
    body.mode === "style"
      ? body.tags.map((t) => t.tag).join(" + ")
      : body.mode === "discover"
        ? `Artists like ${body.artistName}`
        : body.mode === "sounds-like"
          ? soundsLikeTitle(body)
          : SUBMODE_TITLE[body.submode](body.artistName);

  const kind =
    body.mode === "style"
      ? "style"
      : body.mode === "discover"
        ? "discover_artists"
        : body.mode === "sounds-like"
          ? body.seedKind === "tracks"
            ? "sounds_like_tracks"
            : "sounds_like_albums"
          : SUBMODE_KIND[body.submode];

  const seed = seedFromString(
    `${title}|${Date.now()}|${constraintValues.obscurity}`,
  );
  const constraints = { ...DEFAULT_CONSTRAINTS, ...constraintValues, seed };

  const playlistId = createPlaylist({
    sessionId,
    kind,
    title,
    params: { ...body, constraints },
  });

  try {
    // Deliberately not awaited: a cold generation makes dozens of rate-limited
    // calls. The client polls GET /api/playlists/[id] instead.
    void startJob(playlistId, (ctx) => {
      if (body.mode === "style") {
        return runStyle({ playlistId, seeds: body.tags, constraints }, ctx);
      }
      if (body.mode === "sounds-like") {
        return runSoundsLike(
          {
            playlistId,
            seedKind: body.seedKind,
            tracks: body.tracks,
            albums: body.albums,
            constraints,
          },
          ctx,
        );
      }
      if (body.mode === "discover") {
        return runDiscover(
          {
            playlistId,
            artistMbid: body.artistMbid,
            artistName: body.artistName,
            constraints,
          },
          ctx,
        );
      }
      return runIntroduce(
        {
          playlistId,
          artistMbid: body.artistMbid,
          artistName: body.artistName,
          submode: body.submode,
          constraints,
        },
        ctx,
      );
    });
  } catch (error) {
    if (error instanceof TooManyJobsError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }

  return NextResponse.json({ id: playlistId }, { status: 202 });
}
