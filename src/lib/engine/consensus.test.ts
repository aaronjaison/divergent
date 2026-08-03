import { describe, expect, it } from "vitest";
import {
  consensusProfile,
  matchedSeedCount,
  usableSeedCount,
  type SeedProfile,
} from "./consensus";

const seed = (key: string, tags: Record<string, number>): SeedProfile => ({ key, tags });

/** Tags sorted strongest first, which is what the profile is read as. */
const ordered = (tags: Record<string, number>) =>
  Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

describe("consensusProfile", () => {
  it("puts what the seeds share above what any one of them has alone", () => {
    // Five liquid drum and bass records, each with a private tag beside the
    // shared ones. The shared pair must come out on top even though every
    // private tag is at full strength on its own seed.
    const profile = consensusProfile([
      seed("a", { "drum and bass": 1, liquid: 0.9, jungle: 0.4 }),
      seed("b", { "drum and bass": 1, liquid: 0.8, "future jazz": 0.5 }),
      seed("c", { "drum and bass": 0.9, liquid: 1, breakbeat: 0.6 }),
      seed("d", { "drum and bass": 1, liquid: 0.7, "atmospheric drum and bass": 0.5 }),
      seed("e", { "drum and bass": 0.8, liquid: 1, "deep house": 0.6 }),
    ]);

    expect(ordered(profile.tags).slice(0, 2).sort()).toEqual([
      "drum and bass",
      "liquid",
    ]);
    expect(profile.agreement).toBeGreaterThan(0.7);
    expect(profile.usedSeeds).toBe(5);
  });

  it("removes an outlier's genres entirely rather than merely shrinking them", () => {
    /**
     * The case the whole module exists for. One drill single among four
     * shoegaze records must not leave drill in the profile at ANY weight:
     * candidates are ordered by rank, and about half of any co-listening list
     * ties at zero fit, so even a trace of drill lifts a pure drill artist
     * clear of that entire block.
     */
    const profile = consensusProfile([
      seed("a", { shoegaze: 1, "dream pop": 0.7, "noise pop": 0.4 }),
      seed("b", { shoegaze: 1, "dream pop": 0.6 }),
      seed("c", { shoegaze: 0.9, "dream pop": 0.8, "space rock": 0.3 }),
      seed("d", { shoegaze: 1, "noise pop": 0.5 }),
      seed("e", { drill: 1, "uk drill": 0.9, "trap rap": 0.6 }),
    ]);

    expect(profile.tags.drill).toBeUndefined();
    expect(profile.tags["uk drill"]).toBeUndefined();
    expect(profile.tags["trap rap"]).toBeUndefined();
    expect(profile.tags.shoegaze).toBe(1);

    // And the listener is told the picks did not hang together.
    expect(profile.agreement).toBeLessThan(0.7);
  });

  it("keeps every seed's tags when the seeds share nothing at all", () => {
    // No majority view exists, so suppressing the minority would suppress
    // everything. The coverage factor is identical across all five tags here,
    // and normalising by the peak cancels it — see consensusProfile.
    const profile = consensusProfile([
      seed("a", { shoegaze: 1 }),
      seed("b", { "uk drill": 1 }),
      seed("c", { "bossa nova": 1 }),
      seed("d", { "black metal": 1 }),
      seed("e", { "musique concrète": 1 }),
    ]);

    expect(Object.keys(profile.tags).sort()).toEqual([
      "black metal",
      "bossa nova",
      "musique concrète",
      "shoegaze",
      "uk drill",
    ]);
    expect(profile.agreement).toBe(0);
  });

  it("does not collapse to an umbrella when that is all the seeds agree on", () => {
    /**
     * Three rock records whose only common tag is "rock" keep their own
     * genres. Trimming here would produce a profile of literally `{rock: 1}`,
     * which matches every guitar band alive and orders candidates worse than
     * no profile at all.
     */
    const profile = consensusProfile([
      seed("a", { rock: 1, "math rock": 0.9 }),
      seed("b", { rock: 1, "southern rock": 0.8 }),
      seed("c", { rock: 1, "krautrock": 0.9 }),
    ]);

    expect(profile.tags["math rock"]).toBeGreaterThan(0);
    expect(profile.tags["southern rock"]).toBeGreaterThan(0);
    expect(profile.tags["krautrock"]).toBeGreaterThan(0);
  });

  it("trims once the seeds agree on something specific", () => {
    // Same shape as above, but the shared tag is a real style rather than an
    // umbrella, so a lone dissenting tag is dropped.
    const profile = consensusProfile([
      seed("a", { "math rock": 1, midwest: 0.5 }),
      seed("b", { "math rock": 1, emo: 0.5 }),
      seed("c", { "math rock": 1, "post-hardcore": 0.5 }),
    ]);

    expect(profile.tags["math rock"]).toBe(1);
    expect(profile.tags.midwest).toBeUndefined();
    expect(profile.tags.emo).toBeUndefined();
  });

  it("keeps a minority tag when only two seeds are given", () => {
    // One of two is half the evidence, not a minority view — there is no way
    // to tell an outlier from a genuine distinction at this size.
    const profile = consensusProfile([
      seed("a", { shoegaze: 1, "dream pop": 0.6 }),
      seed("b", { shoegaze: 1, "noise pop": 0.6 }),
    ]);

    expect(profile.tags["dream pop"]).toBeGreaterThan(0);
    expect(profile.tags["noise pop"]).toBeGreaterThan(0);
  });

  it("passes a single seed through as itself", () => {
    const profile = consensusProfile([
      seed("a", { "art rock": 10, experimental: 5, "alternative rock": 2 }),
    ]);

    expect(profile.tags["art rock"]).toBe(1);
    expect(profile.tags.experimental).toBeCloseTo(0.5);
    expect(profile.agreement).toBe(1);
    expect(profile.usedSeeds).toBe(1);
  });

  it("drops tags that describe anything other than the sound", () => {
    // "seen live" is the strongest tag on plenty of MusicBrainz records. If it
    // were dropped after normalisation rather than before, every real genre
    // beneath it would fall under the floor and the seed would vote for nothing.
    const profile = consensusProfile([
      seed("a", { "seen live": 100, british: 80, "1990s": 60, shoegaze: 8 }),
      seed("b", { "seen live": 90, shoegaze: 6, "dream pop": 4 }),
    ]);

    expect(profile.tags["seen live"]).toBeUndefined();
    expect(profile.tags.british).toBeUndefined();
    expect(profile.tags["1990s"]).toBeUndefined();
    expect(profile.tags.shoegaze).toBe(1);
  });

  it("survives seeds MusicBrainz knows nothing about", () => {
    const profile = consensusProfile([
      seed("a", {}),
      seed("b", { shoegaze: 1 }),
      seed("c", { "seen live": 5 }),
    ]);

    // Untagged seeds abstain rather than voting against, so the one real
    // profile comes through undiluted.
    expect(profile.tags.shoegaze).toBe(1);
    expect(profile.usedSeeds).toBe(1);
    expect(profile.agreement).toBe(1);
  });

  it("returns an empty profile without NaN when nothing is usable", () => {
    const profile = consensusProfile([seed("a", {}), seed("b", { british: 1 })]);

    expect(profile.tags).toEqual({});
    expect(profile.agreement).toBe(0);
    expect(profile.usedSeeds).toBe(0);
    expect(Number.isNaN(profile.agreement)).toBe(false);
  });

  it("returns an empty profile for no seeds at all", () => {
    expect(consensusProfile([])).toEqual({
      tags: {},
      agreement: 0,
      usedSeeds: 0,
      seeds: [],
    });
  });

  it("counts a repeated pick once", () => {
    const twice = [
      seed("same", { shoegaze: 1, "dream pop": 0.5 }),
      seed("same", { shoegaze: 1, "dream pop": 0.5 }),
      seed("other", { shoegaze: 1, "noise pop": 0.5 }),
    ];

    expect(usableSeedCount(twice)).toBe(2);
    expect(consensusProfile(twice).usedSeeds).toBe(2);
  });

  it("normalises seeds against themselves, so a heavily tagged pick cannot dominate", () => {
    /**
     * MusicBrainz strengths are vote counts, and a famous record collects two
     * orders of magnitude more of them than an obscure one. Without per-seed
     * normalisation the obscure pick would contribute nothing measurable.
     */
    const profile = consensusProfile([
      seed("famous", { "alternative rock": 900, "art rock": 700, "trip hop": 400 }),
      seed("obscure", { "trip hop": 3, "downtempo": 2 }),
    ]);

    expect(ordered(profile.tags)[0]).toBe("trip hop");
    expect(profile.tags["downtempo"]).toBeGreaterThan(0);
  });

  it("caps the profile so a wide consensus stays a profile", () => {
    const wide = Array.from({ length: 5 }, (_, i) =>
      seed(
        `seed-${i}`,
        Object.fromEntries(
          Array.from({ length: 30 }, (_, j) => [`style-${i}-${j}`, 1 - j * 0.02]),
        ),
      ),
    );

    expect(Object.keys(consensusProfile(wide).tags).length).toBeLessThanOrEqual(24);
  });
});

describe("usableSeedCount", () => {
  it("counts only the seeds that can contribute", () => {
    expect(
      usableSeedCount([
        seed("a", { shoegaze: 1 }),
        seed("b", {}),
        seed("c", { "seen live": 10 }),
        seed("d", { "dream pop": 0.5 }),
      ]),
    ).toBe(2);
  });
});

describe("matchedSeedCount", () => {
  /**
   * The real pair that exposed the need for this: Lil Yachty's *Let's Start
   * Here* and Tame Impala's *Currents*, as MusicBrainz actually tags them.
   * Two psychedelic records whose audiences have nothing to do with each other.
   */
  const LETS_START_HERE = seed("lsh", {
    "psychedelic rock": 1,
    "space rock": 0.667,
    "psychedelic pop": 0.333,
    "neo-psychedelia": 0.333,
    "neo soul": 0.333,
    "psychedelic soul": 0.333,
    "art pop": 0.333,
  });
  const CURRENTS = seed("cur", {
    "psychedelic rock": 1,
    "neo-psychedelia": 0.667,
    rock: 0.5,
    "psychedelic pop": 0.333,
    electronic: 0.167,
    "indie rock": 0.167,
    "synth-pop": 0.167,
    "dream pop": 0.167,
  });
  const BOTH = [LETS_START_HERE, CURRENTS];
  const NO_SUPPORT = new Set<string>();

  it("counts both seeds for an artist that genuinely fits both", () => {
    // Pond, as tagged: psychedelic rock, space rock, neo-psychedelia.
    const pond = { "psychedelic rock": 1, "space rock": 0.8, "neo-psychedelia": 0.7 };
    expect(matchedSeedCount(pond, BOTH, NO_SUPPORT)).toBe(2);
  });

  it("counts one seed for an artist that only fits one of them", () => {
    // The War on Drugs: 0.17 against the first record, 0.49 against the second.
    const warOnDrugs = {
      "indie rock": 1,
      "dream pop": 0.6,
      "heartland rock": 0.6,
      "neo-psychedelia": 0.4,
    };
    expect(matchedSeedCount(warOnDrugs, BOTH, NO_SUPPORT)).toBe(1);
  });

  it("counts nothing for the rap that co-listening kept offering", () => {
    // Every rap artist in the shortlist scored exactly 0.00 against each record.
    const rap: Record<string, number>[] = [
      { "hip hop": 1, "southern hip hop": 1, trap: 1 },
      { trap: 1, "hip hop": 0.8, "gangsta rap": 0.8, "pop rap": 0.6 },
      { "hip hop": 1, "east coast hip hop": 0.7, "emo rap": 0.5 },
    ];
    for (const tags of rap) {
      expect(matchedSeedCount(tags, BOTH, NO_SUPPORT)).toBe(0);
    }
  });

  it("credits co-listening for an artist MusicBrainz has never tagged", () => {
    // The only evidence available for a small artist, and the reason support
    // counts at all: scoring the untagged at zero buries exactly the artists
    // this app exists to surface.
    expect(matchedSeedCount(undefined, BOTH, new Set(["cur"]))).toBe(1);
    expect(matchedSeedCount({}, BOTH, new Set(["lsh", "cur"]))).toBe(2);
  });

  it("does not double-count a seed that both matches and supports", () => {
    const pond = { "psychedelic rock": 1, "space rock": 0.8, "neo-psychedelia": 0.7 };
    expect(matchedSeedCount(pond, BOTH, new Set(["lsh", "cur"]))).toBe(2);
  });

  it("counts a seed that carried no tags at all but did name the artist", () => {
    // An untagged seed is absent from the profiles, so its only route into the
    // count is its support — which must still be worth a tier.
    expect(matchedSeedCount({ shoegaze: 1 }, [LETS_START_HERE], new Set(["untagged"])))
      .toBe(1);
  });

  it("ranks a two-seed match above a strong one-seed match", () => {
    const pond = { "psychedelic rock": 1, "space rock": 0.8, "neo-psychedelia": 0.7 };
    const beachHouse = { "dream pop": 1, "indie pop": 0.7, shoegaze: 0.6 };
    expect(matchedSeedCount(pond, BOTH, NO_SUPPORT)).toBeGreaterThan(
      matchedSeedCount(beachHouse, BOTH, NO_SUPPORT),
    );
  });
});
