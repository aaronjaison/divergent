import { tagCosine, tagSpecificity } from "./scoring";

/**
 * What several songs or albums have in common.
 *
 * Pure, like the rest of the engine.
 *
 * Seeding a playlist from one track can only tell you a genre. Seeding it from
 * five tells you which corner of that genre the listener actually means — but
 * only if the profile is built from what they AGREE on. Averaging the five
 * profiles does not do that: an average keeps every tag any one of them
 * carried, so a single outlier survives at a fifth of its strength and steers
 * the result. The fix is to weight each tag by how many seeds carry it, hard
 * enough that a lone tag stops mattering once there is anything to compare it
 * against.
 */

/**
 * Tags below this share of a seed's own peak are dropped before it votes.
 *
 * MusicBrainz tag lists have a long tail of one-vote noise. Left in, that tail
 * is what the agreement measure ends up comparing, and two records that share
 * nothing but a stray tag read as related.
 */
const SEED_TAG_FLOOR = 0.05;

/**
 * How sharply coverage is rewarded: a tag `k` of `n` seeds carry is scaled by
 * `(k/n)^SHARPNESS`.
 *
 * Squared rather than linear because the linear version is too gentle to do the
 * job. With five seeds, one seed's private tag keeps a fifth of its weight
 * linearly and a twenty-fifth squared — and a fifth is more than enough to
 * outrank a tag four of the five share, once specificity is applied.
 */
const SHARPNESS = 2;

/** Tags below this share of the profile's peak are dropped from the result. */
const KEEP_FLOOR = 0.05;

/**
 * Seeds that must agree on SOMETHING before uncorroborated tags are discarded
 * outright rather than merely suppressed.
 *
 * Three, because with two seeds there is no way to tell an outlier from a real
 * distinction — one of two is half the evidence, not a minority view.
 */
const TRIM_SUPPORT = 3;

/**
 * The corroborated tags must include something at least this specific before
 * uncorroborated ones are trimmed.
 *
 * Without the guard, three seeds sharing nothing but "rock" collapse to a
 * profile of exactly `{rock: 1}` — which measurably reorders the candidates
 * worse than keeping every seed's own tags would have. Agreeing on an umbrella
 * is not agreement.
 */
const TRIM_SPECIFICITY = 0.5;

/** Cap on the result, so a wide consensus stays a profile and not a census. */
const MAX_TAGS = 24;

/**
 * Cosine at which a candidate counts as a match for ONE seed, rather than for
 * what the seeds share.
 *
 * Measured, on the pair that exposed the need for it — Lil Yachty's *Let's Start
 * Here* and Tame Impala's *Currents*, two psychedelic records with completely
 * different audiences. Against those two profiles the genuine answers score
 * between 0.38 and 0.75 on both (MGMT 0.43/0.75, Pond 0.65/0.56, King Gizzard
 * 0.38/0.50, Unknown Mortal Orchestra 0.40/0.46) while every rap artist the
 * co-listening data offered scored exactly 0.00 against each of them. In
 * between sit the one-sided matches this threshold exists to admit: Kasabian
 * 0.19/0.45, The War on Drugs 0.17/0.49, Washed Out 0.15/0.45 — all plainly
 * neighbours of the second record and not of the first.
 *
 * 0.2 puts the line under the true matches and far above the noise, with the
 * nearest false positive an order of magnitude below it.
 */
export const SEED_MATCH_FLOOR = 0.2;

export interface SeedProfile {
  /** Stable identity, for dedupe — an MBID in practice. */
  key: string;
  /** The seed's own genre profile, tag -> strength. Any scale; renormalised. */
  tags: Readonly<Record<string, number>>;
}

export interface ConsensusProfile {
  /** tag -> 0-1, peak-normalised, best first. */
  tags: Record<string, number>;
  /**
   * How much the seeds actually have in common, 0-1: the mean cosine over every
   * pair of them. One seed agrees with itself, so a single seed scores 1.
   *
   * Surfaced because it changes what the playlist can honestly promise. Five
   * seeds that agree describe a sound; five that do not describe a listener,
   * and the result is a fair blend rather than a match.
   */
  agreement: number;
  /**
   * Seeds that carried usable tags. Lower than the number supplied whenever
   * MusicBrainz has nothing on one of the picks, which is common below the
   * famous — the caller needs the real figure before telling anyone that five
   * songs were used.
   */
  usedSeeds: number;
  /**
   * The cleaned per-seed profiles the consensus was built from, in the order
   * they were supplied and keyed as they arrived.
   *
   * Handed back because the consensus alone cannot answer the question that
   * decides the playlist when the seeds only half agree: not "does this
   * candidate fit the average" but "which of these records does it fit". See
   * matchedSeedCount.
   */
  seeds: SeedProfile[];
}

/**
 * One seed's tags, cleaned and renormalised, or `{}` if nothing survives.
 *
 * The ORDER of these steps is the whole trick. Renormalising before applying
 * the floor is what keeps a lightly-tagged album in the vote: MusicBrainz
 * strengths are raw vote counts, so an album with three votes for "shoegaze"
 * and a hundred-vote artist beside it would otherwise fall under any absolute
 * floor. And dropping non-genre tags BEFORE renormalising matters just as much
 * — on plenty of records the strongest tag is "seen live", and normalising to
 * that peak first pushes every real genre under the floor.
 */
function cleanSeed(tags: Readonly<Record<string, number>>): Record<string, number> {
  const genres = Object.entries(tags).filter(
    ([tag, strength]) => strength > 0 && tagSpecificity(tag) > 0,
  );
  if (genres.length === 0) return {};

  const peak = Math.max(...genres.map(([, strength]) => strength));
  if (peak <= 0) return {};

  const cleaned: Record<string, number> = {};
  for (const [tag, strength] of genres) {
    const normalised = strength / peak;
    if (normalised >= SEED_TAG_FLOOR) cleaned[tag] = normalised;
  }
  return cleaned;
}

/** The seeds that can actually vote: deduped, and tagged with something usable. */
function usableSeeds(seeds: readonly SeedProfile[]): SeedProfile[] {
  const seen = new Set<string>();
  const out: SeedProfile[] = [];

  for (const seed of seeds) {
    if (seed.key && seen.has(seed.key)) continue;
    if (seed.key) seen.add(seed.key);

    const cleaned = cleanSeed(seed.tags);
    // An untagged seed is absence of evidence, not disagreement. Counting it in
    // `n` would penalise every tag the others share for a gap in MusicBrainz's
    // coverage, so it drops out of the vote entirely rather than voting against.
    if (Object.keys(cleaned).length > 0) out.push({ key: seed.key, tags: cleaned });
  }

  return out;
}

/**
 * How many of these seeds will contribute anything. Exported because it is
 * routinely lower than the number the listener picked, and both the warnings
 * and the playlist's description have to say the true figure.
 */
export function usableSeedCount(seeds: readonly SeedProfile[]): number {
  return usableSeeds(seeds).length;
}

/**
 * The profile to build a playlist around, given everything the listener picked.
 */
export function consensusProfile(seeds: readonly SeedProfile[]): ConsensusProfile {
  const profiles = usableSeeds(seeds);
  const n = profiles.length;
  if (n === 0) return { tags: {}, agreement: 0, usedSeeds: 0, seeds: [] };

  const carriers = new Map<string, number[]>();
  for (const profile of profiles) {
    for (const [tag, strength] of Object.entries(profile.tags)) {
      const existing = carriers.get(tag);
      if (existing) existing.push(strength);
      else carriers.set(tag, [strength]);
    }
  }

  const bestSupport = Math.max(...[...carriers.values()].map((s) => s.length));
  const corroborated = [...carriers.entries()].filter(([, s]) => s.length >= 2);

  /**
   * Whether a tag only one seed carries is dropped rather than just suppressed.
   *
   * Suppression alone is not enough, and the reason is specific to how this
   * engine orders candidates. Fit is combined by RANK, and roughly half of any
   * co-listening list scores exactly zero on fit — so a surviving outlier tag
   * that gives an off-genre candidate a fit of 0.07 lifts it clear of that
   * entire tie block. The outlier stops steering the profile and carries on
   * steering the ordering, which is the part that reaches the listener.
   *
   * Keyed to how much agreement exists rather than to the seed count, so five
   * seeds that share nothing keep their full union — there is no majority view
   * to prefer, and the honest answer is all of them.
   */
  const trimOutliers =
    bestSupport >= TRIM_SUPPORT &&
    corroborated.some(([tag]) => tagSpecificity(tag) >= TRIM_SPECIFICITY);

  const raw = new Map<string, number>();
  for (const [tag, strengths] of carriers) {
    if (trimOutliers && strengths.length < 2) continue;

    const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
    // Averaged over CARRIERS, not over all seeds, and the coverage penalty then
    // applied explicitly. Folding the two together — summing and dividing by n
    // — would penalise a tag twice for the same gap and leave the shape of the
    // penalty implicit rather than tunable.
    raw.set(tag, mean * Math.pow(strengths.length / n, SHARPNESS));
  }

  const peak = Math.max(0, ...raw.values());
  if (peak <= 0) {
    return { tags: {}, agreement: agreementOf(profiles), usedSeeds: n, seeds: profiles };
  }

  /**
   * Normalised AFTER the coverage penalty, which is what makes the disjoint
   * case come out right. When the seeds share nothing every tag takes the same
   * `(1/n)^SHARPNESS` factor, so dividing by the peak cancels it exactly and
   * the result is the union of the picks rather than nothing at all. That falls
   * out of the arithmetic instead of needing a special case to catch it.
   */
  const tags: Record<string, number> = {};
  for (const [tag, value] of [...raw.entries()]
    .map(([tag, value]) => [tag, value / peak] as const)
    .filter(([, value]) => value >= KEEP_FLOOR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TAGS)) {
    tags[tag] = value;
  }

  return { tags, agreement: agreementOf(profiles), usedSeeds: n, seeds: profiles };
}

/**
 * How many of the listener's picks a candidate actually matches.
 *
 * This is the difference between "fits the average of what you chose" and
 * "fits what you chose", and the two come apart exactly when the picks do. Seed
 * two psychedelic records with unrelated audiences and the consensus is a fine
 * description of both, but the candidate pool is dominated by whichever record
 * has the larger following — so ranking on the consensus alone hands the
 * playlist to one seed and quietly drops the other.
 *
 * Counting matches per seed instead lets the caller fill from the candidates
 * that answer to every pick before it reaches down to the ones that answer to
 * only one, which is the honest order: an artist both your records point at is
 * a better answer than an artist one of them points at, and an artist neither
 * points at is not an answer at all.
 *
 * A candidate matches a seed on either kind of evidence. Genre is the stronger
 * of the two and is checked against that seed's own profile rather than the
 * consensus. Co-listening counts as well, because it is the only evidence
 * available for the artists MusicBrainz has never tagged — and those are
 * disproportionately the small ones this app exists to surface.
 */
export function matchedSeedCount(
  candidateTags: Readonly<Record<string, number>> | undefined,
  profiled: readonly SeedProfile[],
  supportedKeys: ReadonlySet<string>,
  floor = SEED_MATCH_FLOOR,
): number {
  // Seeds that carried no usable tags are absent from `profiled` but can still
  // appear in `supportedKeys`, so the union is taken over keys rather than
  // counted per source.
  const matched = new Set(supportedKeys);

  if (candidateTags && Object.keys(candidateTags).length > 0) {
    for (const seed of profiled) {
      if (tagCosine(candidateTags, seed.tags) >= floor) matched.add(seed.key);
    }
  }

  return matched.size;
}

/**
 * Mean cosine over every PAIR of seeds.
 *
 * Pairwise rather than each-seed-against-the-centroid, because a seed is a
 * component of its own centroid: two completely unrelated seeds each sit at
 * about 0.71 from the average of the two, which reads as agreement where there
 * is none.
 *
 * Mean rather than median, because the median hides exactly the case this
 * number exists to expose. Four shoegaze records and one drill single score
 * around 0.60 as a mean and around 0.85 as a median — and the second is a lie,
 * since a fifth of what the listener asked for is about to go missing.
 */
function agreementOf(profiles: readonly SeedProfile[]): number {
  if (profiles.length === 0) return 0;
  if (profiles.length === 1) return 1;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      total += tagCosine(profiles[i].tags, profiles[j].tags);
      pairs++;
    }
  }
  return total / pairs;
}
