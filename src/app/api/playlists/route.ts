import { NextResponse } from "next/server";
import { z } from "zod";
import { createPlaylist } from "@/lib/db/repo/playlists";
import { seedFromString } from "@/lib/engine/random";
import { DEFAULT_CONSTRAINTS } from "@/lib/engine/types";
import { getOrCreateSessionId } from "@/lib/session/anonSession";
import { startJob, TooManyJobsError } from "@/lib/services/generationJobs";
import { runIntroduce, runStyle } from "@/lib/services/playlistService";

const constraintsSchema = z.object({
  targetLength: z.number().int().min(5).max(100).default(DEFAULT_CONSTRAINTS.targetLength),
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

const bodySchema = z.discriminatedUnion("mode", [styleSchema, introduceSchema]);

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
      : SUBMODE_TITLE[body.submode](body.artistName);

  const seed = seedFromString(
    `${title}|${Date.now()}|${constraintValues.obscurity}`,
  );
  const constraints = { ...DEFAULT_CONSTRAINTS, ...constraintValues, seed };

  const playlistId = createPlaylist({
    sessionId,
    kind: body.mode === "style" ? "style" : SUBMODE_KIND[body.submode],
    title,
    params: { ...body, constraints },
  });

  try {
    // Deliberately not awaited: a cold generation makes dozens of rate-limited
    // calls. The client polls GET /api/playlists/[id] instead.
    void startJob(playlistId, (ctx) =>
      body.mode === "style"
        ? runStyle({ playlistId, seeds: body.tags, constraints }, ctx)
        : runIntroduce(
            {
              playlistId,
              artistMbid: body.artistMbid,
              artistName: body.artistName,
              submode: body.submode,
              constraints,
            },
            ctx,
          ),
    );
  } catch (error) {
    if (error instanceof TooManyJobsError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }

  return NextResponse.json({ id: playlistId }, { status: 202 });
}
