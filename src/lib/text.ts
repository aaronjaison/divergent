/**
 * Text normalisation shared by providers (matching) and the engine (dedupe).
 *
 * Cross-source matching lives or dies here: MusicBrainz, Deezer and Last.fm
 * spell the same track three different ways, and Spotify no longer returns
 * ISRCs, so string comparison carries more weight than it should.
 */

/** Suffixes that mark the same song, not a different one. */
const VERSION_SUFFIX =
  /\s*[([]\s*(?:\d{4}\s*)?(?:digital\s+)?(?:remaster(?:ed)?|remastered\s+version|deluxe(?:\s+edition)?|bonus\s+track|album\s+version|single\s+version|mono|stereo|explicit|clean|radio\s+edit|expanded(?:\s+edition)?|anniversary\s+edition|reissue)[^)\]]*[)\]]\s*/gi;

const FEATURED = /\s*[([]\s*(?:feat|ft|featuring)\.?\s[^)\]]*[)\]]/gi;
const TRAILING_DASH_VERSION =
  /\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|remastered\s+version|mono|stereo|single\s+version|album\s+version|radio\s+edit|deluxe|bonus\s+track)(?:\s+version)?\s*$/gi;

/**
 * Strips accents, punctuation and reissue noise so "Café (2011 Remaster)" and
 * "Cafe" collapse to one key. Aggressive by design — false merges of genuinely
 * different tracks are rarer and less damaging than the same song appearing
 * three times in a 25-track playlist.
 */
export function normalizeTitle(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(FEATURED, " ")
    .replace(VERSION_SUFFIX, " ")
    .replace(TRAILING_DASH_VERSION, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Same treatment for artist names, plus a leading "the". */
export function normalizeArtistName(input: string): string {
  return normalizeTitle(input).replace(/^the\s+/, "");
}

/**
 * Identity of the underlying song, ignoring which version this is.
 *
 * Stronger than normalizeTitle: it drops every parenthetical and bracketed
 * qualifier, so "Creep", "Creep (Acoustic)" and "Creep - Live" collapse to one
 * key. Used only for playlist dedupe — a playlist that opens with Creep and
 * closes with Creep (Acoustic) reads as a bug, whatever the catalogue says.
 *
 * Deliberately NOT used for cross-source matching, where an acoustic take and
 * the studio version are genuinely different recordings.
 */
export function songIdentity(input: string): string {
  return normalizeTitle(
    input
      .replace(/[([][^)\]]*[)\]]/g, " ")
      .replace(/\s+-\s+.*$/, " "),
  );
}

/** 0-1 similarity via normalised Levenshtein distance. */
export function stringSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === right) return 1;
  if (!left.length || !right.length) return 0;

  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/** ISRCs are compared without hyphens/spaces and upper-cased. */
export function normalizeIsrc(isrc: string | undefined | null): string | undefined {
  if (!isrc) return undefined;
  const cleaned = isrc.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(cleaned) ? cleaned : undefined;
}
