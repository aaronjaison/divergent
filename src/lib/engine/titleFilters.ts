import type { EngineTrack, StyleConstraints } from "./types";

/**
 * Track-level filtering.
 *
 * These patterns are the difference between a playlist and a mess: album
 * catalogues are full of skits, live takes and alternate mixes that read as
 * padding when they land next to the real thing.
 */

const EXCLUDED_TITLE = new RegExp(
  [
    "\\blive\\b(?!\\s*(?:and|forever|wire|through))", // "Live at ..." but not "Live Forever"
    "\\bremix\\b",
    "\\bedit\\b",
    "\\binstrumental\\b",
    "\\bkaraoke\\b",
    "\\bdemo\\b",
    "\\bskit\\b",
    "\\binterlude\\b",
    "\\bintro\\b",
    "\\boutro\\b",
    "\\bcommentary\\b",
    "\\brehearsal\\b",
    "\\bsession\\b",
    "\\bacoustic version\\b",
    "\\bradio (?:edit|session)\\b",
    "\\bbbc\\b",
    "\\bunplugged\\b",
    "\\bmedley\\b",
    "\\breprise\\b",
  ].join("|"),
  "i",
);

/** Release types that shouldn't feed a deep-cuts or style playlist. */
const EXCLUDED_SECONDARY_TYPES = new Set([
  "live",
  "compilation",
  "soundtrack",
  "remix",
  "dj-mix",
  "mixtape/street",
  "interview",
  "spokenword",
  "audiobook",
  "demo",
]);

export function isExcludedTitle(title: string): boolean {
  return EXCLUDED_TITLE.test(title);
}

export function isExcludedReleaseType(secondaryTypes: readonly string[] = []): boolean {
  return secondaryTypes.some((type) =>
    EXCLUDED_SECONDARY_TYPES.has(type.toLowerCase()),
  );
}

function withinDuration(track: EngineTrack, constraints: StyleConstraints): boolean {
  // Unknown duration is common in MusicBrainz and is not grounds for exclusion.
  if (track.durationMs === undefined) return true;
  const min = constraints.minDurationMs ?? 0;
  const max = constraints.maxDurationMs ?? Number.POSITIVE_INFINITY;
  return track.durationMs >= min && track.durationMs <= max;
}

function withinEra(track: EngineTrack, constraints: StyleConstraints): boolean {
  if (constraints.eraFrom === undefined && constraints.eraTo === undefined) return true;
  // An era filter is an explicit request; a track we can't date cannot satisfy it.
  if (track.year === undefined) return false;
  if (constraints.eraFrom !== undefined && track.year < constraints.eraFrom) return false;
  if (constraints.eraTo !== undefined && track.year > constraints.eraTo) return false;
  return true;
}

export function passesFilters(
  track: EngineTrack,
  constraints: StyleConstraints,
): boolean {
  if (isExcludedTitle(track.title)) return false;
  if (!withinDuration(track, constraints)) return false;
  if (!withinEra(track, constraints)) return false;
  // A fuzzy match is a guess about which recording this is. In 'hard' mode the
  // listener knows none of the tracks, so a wrong one is undetectable — and
  // therefore worth avoiding most.
  if (constraints.obscurity === "hard" && track.matchConfidence === "fuzzy") {
    return false;
  }
  return true;
}

/**
 * Drops repeats of the same song. Keeps the first occurrence, which callers
 * order by preference (better match confidence and known popularity first).
 */
export function dedupeTracks(tracks: readonly EngineTrack[]): EngineTrack[] {
  const seenKeys = new Set<string>();
  const seenSongs = new Set<string>();
  const out: EngineTrack[] = [];

  for (const track of tracks) {
    const songKey = `${track.artistKey}::${track.titleNorm}`;
    if (seenKeys.has(track.key) || seenSongs.has(songKey)) continue;
    seenKeys.add(track.key);
    seenSongs.add(songKey);
    out.push(track);
  }

  return out;
}
