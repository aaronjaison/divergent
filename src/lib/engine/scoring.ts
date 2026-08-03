import type { ObscurityBand } from "./types";

/**
 * Cross-checking co-listening similarity against genre.
 *
 * Session-based similarity answers "who else do these listeners play?", which
 * is not the same question as "who sounds like this?". For a widely-played
 * artist the two diverge badly: ask for artists like Radiohead and you get
 * Green Day and Daft Punk — genuinely co-listened, sonically unrelated, and
 * useless to someone who wants to hear something new.
 *
 * Weighting similarity by genre overlap fixes that without discarding the
 * co-listening signal, which is still the best evidence that two artists
 * belong in the same playlist.
 */

/**
 * Top-level categories. Two artists sharing one of these have told you almost
 * nothing: "rap" covers both a drill record and a lo-fi bedroom track, and
 * treating that as evidence of similarity is how a playlist ends up mixing
 * artists with nothing in common but a section of a record shop.
 */
const UMBRELLA_TAGS = new Set([
  "rock", "pop", "hip hop", "hip-hop", "rap", "electronic", "electronica",
  "dance", "r&b", "rnb", "rhythm and blues", "soul", "jazz", "blues", "metal",
  "punk", "folk", "country", "classical", "reggae", "latin", "world",
  "world music", "experimental", "alternative", "indie", "urban", "pop music",
  // These read as styles but behave as umbrellas: "alternative rock" is shared
  // by Radiohead, Train and The Fray, so counting it as real evidence is what
  // let a discovery playlist drift into daytime radio.
  "alternative rock", "indie rock", "indie pop", "pop rock", "alternative pop",
]);

/**
 * One level down: real styles, but still large enough that a shared one is
 * weak evidence on its own.
 */
const BROAD_TAGS = new Set([
  "pop rap", "hard rock", "heavy metal", "house", "techno", "trap", "funk",
  "disco", "ambient", "singer-songwriter", "dance-pop", "dance pop",
  "synthpop", "synth-pop", "electropop", "punk rock", "soundtrack",
  "contemporary r&b", "alternative hip hop", "underground", "art pop",
  "psychedelic rock", "post-punk revival", "emo", "garage rock",
]);

/**
 * Tags that describe anything other than how the music sounds. Nationality,
 * gender and decade tags are common on MusicBrainz and are pure noise for this
 * purpose — two artists both tagged "british" are not thereby similar.
 */
const NON_GENRE_TAGS = new Set([
  "seen live", "favourites", "favorites", "gen z", "male vocalists",
  "female vocalists", "female vocalist", "male vocalist", "british", "english",
  "american", "usa", "uk", "australian", "canadian", "german", "french",
  "swedish", "japanese", "korean", "band", "singer", "producer", "composer",
  "live", "cover", "under 2000 listeners",
]);

/**
 * Bookkeeping tags, which the fixed list above cannot catch because each one is
 * unique to whoever typed it.
 *
 * MusicBrainz's tag field is free text, and a working minority of editors use it
 * as a private filing system. Every one of these came off a real seed record:
 * *Let's Start Here* carries "offizielle charts", "ai cover art" and "1–4
 * wochen"; *Currents* adds "5+ wochen", "ph_temp_checken" and a Discogs list
 * name forty words long. None describes how anything sounds, and left at full
 * specificity they are the sharpest thing in a thinly-tagged album's profile.
 */
const NON_GENRE_PATTERNS = [
  /chart/,
  /^discogs\//,
  // German chart-duration tags: "1–4 wochen", "5+ wochen", "10+ wochen".
  /\bwochen\b/,
  /^ph_/,
  /cover art/,
];

const UMBRELLA_WEIGHT = 0.15;
const BROAD_WEIGHT = 0.5;

/**
 * How much a shared tag counts as evidence that two artists belong together.
 *
 * A curated tier list rather than a computed one. The principled version is
 * inverse document frequency over the tag corpus, but every frequency lookup
 * is a MusicBrainz request at 1/s and a generation touches well over a hundred
 * distinct tags, so that has to wait for a pre-seeded frequency table. The
 * tiers below capture most of the same effect: the categories broad enough to
 * mislead are a small, stable, well-known set.
 */
export function tagSpecificity(tag: string): number {
  const key = tag.trim().toLowerCase();
  if (!key) return 0;
  // "1990s", "2020s", "80s".
  if (/^(19|20)?\d0s$/.test(key)) return 0;
  if (NON_GENRE_TAGS.has(key)) return 0;
  if (NON_GENRE_PATTERNS.some((pattern) => pattern.test(key))) return 0;
  if (UMBRELLA_TAGS.has(key)) return UMBRELLA_WEIGHT;
  if (BROAD_TAGS.has(key)) return BROAD_WEIGHT;
  return 1;
}

/**
 * Weighted Jaccard overlap of two tag sets, 0-1.
 *
 * Weighted rather than plain set overlap because tag strength carries real
 * information: an artist tagged "art rock" at 1.0 and "pop" at 0.05 is not
 * half a pop artist. Each tag is then scaled by how specific it is, so sharing
 * "trap metal" counts for far more than sharing "hip hop".
 */
export function tagOverlap(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;

  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const specificity = tagSpecificity(key);
    if (specificity === 0) continue;
    const left = (a[key] ?? 0) * specificity;
    const right = (b[key] ?? 0) * specificity;
    intersection += Math.min(left, right);
    union += Math.max(left, right);
  }

  return union > 0 ? intersection / union : 0;
}

/**
 * The average tag profile of a group of artists — what the group is "about".
 *
 * Comparing candidates against this rather than against the seed alone is what
 * keeps a playlist in one lane. Similarity to a seed is not transitive: two
 * artists can each be a credible neighbour of the same starting point and have
 * nothing to do with each other, which is exactly how a rap seed ends up
 * pairing a drill artist with a breakbeat-pop one.
 */
export function tagCentroid(
  profiles: readonly { tags: Readonly<Record<string, number>>; weight: number }[],
): Record<string, number> {
  const totals = new Map<string, number>();
  let totalWeight = 0;

  for (const { tags, weight } of profiles) {
    if (weight <= 0 || Object.keys(tags).length === 0) continue;
    totalWeight += weight;
    for (const [tag, strength] of Object.entries(tags)) {
      totals.set(tag, (totals.get(tag) ?? 0) + strength * weight);
    }
  }

  if (totalWeight === 0) return {};

  const centroid: Record<string, number> = {};
  for (const [tag, total] of totals) centroid[tag] = total / totalWeight;
  return centroid;
}

/**
 * Specificity-weighted cosine similarity of two tag profiles, 0-1.
 *
 * Cosine rather than the Jaccard used by tagOverlap, because this compares a
 * single artist against a CENTROID. A centroid drawn from a hundred artists
 * carries a hundred artists' worth of tags, and Jaccard divides by the union —
 * so every candidate's score would sink towards zero as the playlist grew,
 * flattening exactly the discrimination this is for. Cosine normalises by
 * magnitude instead and is stable however many artists the centroid covers.
 */
export function tagCosine(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const [tag, strength] of Object.entries(a)) {
    const weighted = strength * tagSpecificity(tag);
    leftNorm += weighted * weighted;
    const other = (b[tag] ?? 0) * tagSpecificity(tag);
    dot += weighted * other;
  }
  for (const [tag, strength] of Object.entries(b)) {
    const weighted = strength * tagSpecificity(tag);
    rightNorm += weighted * weighted;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/**
 * How well a candidate fits a group, 0-1.
 *
 * An artist with no tags scores `unknown` rather than 0. Tag coverage is
 * uneven and thins out fast below the famous, so scoring a missing profile as
 * "does not fit" would quietly exclude exactly the smaller artists this app
 * exists to surface.
 */
export function coherence(
  candidate: Readonly<Record<string, number>>,
  centroid: Readonly<Record<string, number>>,
  unknown = 0.5,
): number {
  if (Object.keys(candidate).length === 0) return unknown;
  if (Object.keys(centroid).length === 0) return unknown;
  return tagCosine(candidate, centroid);
}

/**
 * How much genre agreement outweighs raw co-listening when ordering
 * candidates. 'easy' leans on co-listening because someone asking for a gentle
 * way in is well served by the obvious neighbours.
 */
const GENRE_RANK_WEIGHT: Record<ObscurityBand, number> = {
  easy: 0.45,
  medium: 0.7,
  hard: 0.8,
};

export interface RankableCandidate {
  /** Co-listening similarity, 0-1. */
  similarity: number;
  /** Genre agreement with the seed, 0-1. */
  fit: number;
}

/**
 * Positions of each value in descending order, scaled 0 (best) to 1 (worst),
 * with ties sharing the midpoint of the span they cover.
 *
 * Ties have to share, because about half of any co-listening list scores
 * exactly zero on genre fit. Splitting that block by arbitrary sort order would
 * let a meaningless tiebreak carry whatever weight genre fit is given, drowning
 * out the signal that is supposed to separate equally off-genre candidates.
 */
export function rankPositions(values: readonly number[]): number[] {
  const count = values.length;
  if (count === 0) return [];
  if (count === 1) return [0];

  const indices = values.map((_, i) => i);
  indices.sort((a, b) => values[b] - values[a]);

  const rank = new Array<number>(count);
  let position = 0;
  while (position < count) {
    let end = position;
    while (end + 1 < count && values[indices[end + 1]] === values[indices[position]]) {
      end++;
    }
    const midpoint = (position + end) / 2 / (count - 1);
    for (let i = position; i <= end; i++) rank[indices[i]] = midpoint;
    position = end + 1;
  }
  return rank;
}

/**
 * Orders candidates by combining their RANK on genre fit with their RANK on
 * co-listening similarity, best first. Returns a 0-1 score per input, in the
 * input's order.
 *
 * This replaced a multiplicative blend (similarity scaled by overlap), which
 * cannot work, and the measurements say so plainly. Asked who is like
 * PinkPantheress, the two signals point in opposite directions:
 *
 *     The Weeknd     similarity 1.000   genre fit 0.029
 *     Nia Archives   similarity 0.223   genre fit 0.294   <- the right answer
 *
 * Any multiplier lands The Weeknd roughly three times higher, because
 * co-listening similarity for a superstar is an order of magnitude larger than
 * for an underground artist and a fractional genre penalty cannot close that
 * gap. Ranks are scale-free, so a candidate that is first on genre and
 * fiftieth on popularity-driven co-listening beats one that is first on
 * co-listening and fiftieth on genre — which is the entire point.
 *
 * The knock-on effect is the one worth having: filtering hard on genre is also
 * what surfaces the smaller artists, because the noise it removes is almost
 * entirely famous.
 */
export function rankByGenreThenSimilarity(
  candidates: readonly RankableCandidate[],
  band: ObscurityBand,
): number[] {
  const count = candidates.length;
  if (count === 0) return [];
  if (count === 1) return [1];

  const fitRank = rankPositions(candidates.map((c) => c.fit));
  const simRank = rankPositions(candidates.map((c) => c.similarity));
  const weight = GENRE_RANK_WEIGHT[band];

  // Ranks run 0 (best) to 1 (worst), so the score is inverted back to
  // "higher is better" for consistency with every other score in the engine.
  return candidates.map(
    (_, i) => 1 - (weight * fitRank[i] + (1 - weight) * simRank[i]),
  );
}

export interface CoherenceCandidate<T> {
  item: T;
  /** The candidate's own genre profile. Empty is allowed and stays neutral. */
  tags: Readonly<Record<string, number>>;
  /** Prior desirability — similarity, tag affinity, band fit, or a blend. */
  score: number;
}

export interface CoherentSelection<T> {
  item: T;
  /** Prior score adjusted for how well the candidate fits the group. */
  value: number;
}

/**
 * Picks a set whose members belong together, rather than a set of members that
 * each individually belong with the seed.
 *
 * The distinction is the whole point. Similarity is not transitive: ask for
 * artists like a broad rap act and both a drill artist and a breakbeat-pop one
 * are defensible answers, but putting them in the same playlist is not. So
 * selection is greedy and the target moves — each pick is scored against the
 * running average of what has already been chosen, which pulls the playlist
 * into one lane and keeps it there.
 *
 * The seed stays in that average at a fixed share so the playlist can settle
 * into a corner of the genre without wandering out of it entirely.
 *
 * `cohesion` is how much fit matters against the prior score, 0-1. At 0 this
 * is a plain sort by score.
 */
export function selectCoherent<T>(
  candidates: readonly CoherenceCandidate<T>[],
  seedTags: Readonly<Record<string, number>>,
  count: number,
  cohesion = 0.6,
): CoherentSelection<T>[] {
  if (candidates.length === 0 || count <= 0) return [];

  const anchorWeight = Math.max(2, count * 0.15);
  const chosenProfiles: { tags: Readonly<Record<string, number>>; weight: number }[] = [
    { tags: seedTags, weight: anchorWeight },
  ];

  const remaining = candidates.slice();
  const out: CoherentSelection<T>[] = [];
  let centroid = tagCentroid(chosenProfiles);

  while (out.length < count && remaining.length > 0) {
    // Fits are measured first so the untagged can be scored at the average of
    // the rest. A fixed neutral value cannot work here: set it high and an
    // artist nobody has tagged beats one verified to be a genuine stylistic
    // match, set it low and the least-tagged artists — the small ones this is
    // meant to surface — are quietly buried.
    const fits = remaining.map((candidate) =>
      Object.keys(candidate.tags).length > 0 && Object.keys(centroid).length > 0
        ? tagCosine(candidate.tags, centroid)
        : undefined,
    );
    const measured = fits.filter((fit): fit is number => fit !== undefined);
    const meanFit =
      measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 0.5;

    // Combined by rank, for the same reason rankByGenreThenSimilarity is: a
    // multiplicative penalty is simply outvoted when the prior scores span
    // orders of magnitude, which they do whenever a famous artist is in the
    // pool. Ranks put the two signals on one scale so cohesion can actually win.
    const fitRank = rankPositions(remaining.map((_, i) => fits[i] ?? meanFit));
    const scoreRank = rankPositions(remaining.map((candidate) => candidate.score));

    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const value = 1 - (cohesion * fitRank[i] + (1 - cohesion) * scoreRank[i]);
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    const [picked] = remaining.splice(bestIndex, 1);
    out.push({ item: picked.item, value: bestValue });

    if (Object.keys(picked.tags).length > 0) {
      chosenProfiles.push({ tags: picked.tags, weight: 1 });
      centroid = tagCentroid(chosenProfiles);
    }
  }

  return out;
}

/** Sum of an artist's affinity for a set of weighted tags. */
export function weightedTagScore(
  affinity: Readonly<Record<string, number>>,
  seeds: readonly { tag: string; weight: number }[],
): number {
  return seeds.reduce(
    (sum, seed) => sum + (affinity[seed.tag] ?? 0) * seed.weight,
    0,
  );
}
