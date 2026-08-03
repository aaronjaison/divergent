import { capPerArtist, relaxToFill } from "./diversity";
import { interleave, separateAdjacent, type Queue } from "./interleave";
import { bandAffinity, percentileRanks, selectTracksForBand } from "./obscurity";
import { selectCoherent } from "./scoring";
import { dedupeTracks, passesFilters } from "./titleFilters";
import { normalizeArtistName } from "@/lib/text";
import type {
  EngineArtist,
  EngineTrack,
  GeneratedPlaylist,
  ObscurityBand,
  StyleConstraints,
} from "./types";

/**
 * "Artists like this one" — a playlist made entirely of OTHER artists.
 *
 * Pure, like the rest of the engine.
 *
 * The difference from a blend is the whole point of the mode: a blend keeps
 * returning to the seed artist so you hear them in context, whereas this
 * deliberately drops them. Someone who already knows the seed well enough to
 * name it does not need another eight of their tracks — they want the widest
 * possible set of artists they have not heard, which is why the default here is
 * one track each and why the seed never appears.
 */

/**
 * How much genre fit outweighs raw similarity when choosing artists. High,
 * because unconstrained co-listening similarity is precisely what produces a
 * playlist that is technically related and unlistenable in sequence.
 */
const COHESION = 0.65;

export interface DiscoverInput {
  /** Only used for the per-track explanation; contributes no tracks. */
  seedArtistName: string;
  /**
   * The genre profile to build around. One artist's for a single-artist
   * discovery; the consensus across several songs or albums when the listener
   * seeded it that way. Anchors the playlist's centre so it can settle into a
   * corner of the sound without wandering out of it.
   */
  seedTags?: Readonly<Record<string, number>>;
  /** Similar artists, each carrying a 0-1 similarity in `score`. */
  similar: { artist: EngineArtist; score: number }[];
  constraints: StyleConstraints;
  /**
   * Per-track explanation. Defaults to "sounds like <seedArtistName>", which is
   * wrong once there are several seeds — "sounds like your 5 songs" is what a
   * multi-seed playlist has to say.
   */
  reason?: string;
  /**
   * Names that must not appear in ANY credit on a track, beyond the artist keys
   * excluded below. Defaults to the seed artist's name. A playlist promising
   * everyone *else* breaks that promise on a guest verse just as surely as on a
   * headline track, and credits are per track rather than per artist.
   */
  excludeCreditNames?: readonly string[];
  /**
   * Which part of each artist's catalogue to draw from. Defaults to their
   * best-known work: a playlist whose job is to make an introduction should
   * introduce each artist at their strongest, and the listener's obscurity
   * setting has already decided how far down the similarity list these artists
   * came from.
   */
  trackBand?: ObscurityBand;
  /** Artist keys to leave out — normally just the seed. */
  excludeArtistKeys?: Set<string>;
}

export function buildDiscovery(input: DiscoverInput): GeneratedPlaylist {
  const {
    seedArtistName,
    seedTags = {},
    similar,
    constraints,
    trackBand = "easy",
    excludeArtistKeys = new Set(),
    reason = `sounds like ${seedArtistName}`,
    excludeCreditNames = [seedArtistName],
  } = input;
  const warnings: string[] = [];

  const eligible = similar.filter(
    (entry) =>
      entry.score > 0 &&
      entry.artist.tracks.length > 0 &&
      !excludeArtistKeys.has(entry.artist.key) &&
      !excludeArtistKeys.has(entry.artist.name),
  );

  if (eligible.length === 0) {
    return {
      tracks: [],
      warnings: [
        `No artists similar to ${seedArtistName} could be found with playable tracks.`,
      ],
    };
  }

  // Similarity alone is not discovery. Asking who sounds like Radiohead
  // truthfully returns Pink Floyd, the Beatles and Led Zeppelin — artists the
  // person asking has certainly already heard. Ranking by similarity ALONE
  // therefore produces a playlist of the most famous plausible answers, which
  // is the opposite of the point.
  //
  // So the obscurity setting bands on audience size here, computed within this
  // pool rather than globally: how famous an artist is relative to the others
  // who sound like this one is the only comparison that means anything.
  const known = eligible.filter((entry) => entry.artist.popularity !== undefined);
  const ranks = percentileRanks(known.map((entry) => entry.artist.popularity as number));
  const percentileByKey = new Map<string, number>();
  known.forEach((entry, index) => percentileByKey.set(entry.artist.key, ranks[index]));

  const prior = eligible.map((entry) => ({
    item: entry,
    tags: entry.artist.tags ?? {},
    // Unknown audience size sits at the median: a provider gap is not
    // evidence of obscurity, and treating it as such would flood the
    // playlist with artists we simply failed to look up.
    score:
      entry.score *
      bandAffinity(percentileByKey.get(entry.artist.key) ?? 50, constraints.obscurity),
  }));

  /**
   * Chosen for fit with each other, not just with the seed. Both a drill
   * artist and a breakbeat-pop one can be honest answers to "who is like this
   * broad rap act", and putting them in one playlist is still wrong — the
   * seed's genre is a starting point, and the playlist has to pick a lane
   * within it. selectCoherent moves the target as it goes, so it does.
   */
  const ordered = selectCoherent(prior, seedTags, prior.length, COHESION);

  // Weighted by POSITION in that greedy order, not by the value it was scored
  // with. Those values are each measured against a different centroid — the
  // one that existed when the pick was made — so they do not compare across
  // picks, and using them directly as weights threw away the very ordering
  // this pass exists to produce.
  const contributors = ordered.map((picked, index) => ({
    ...picked.item,
    weight: (ordered.length - index) / ordered.length,
  }));

  const queues: Queue<EngineTrack>[] = [];
  const reserves: EngineTrack[] = [];

  // The seed artists are excluded by key upstream, but a track can still credit
  // one as a guest on somebody else's record — a discovery playlist that ends
  // on "PinkPantheress, Sam Gellaitry" has broken its one promise. Credits are
  // checked per track, not per artist.
  const seedCredits = new Set(
    excludeCreditNames.map((name) => normalizeArtistName(name)).filter((name) => name.length > 0),
  );
  const creditsSeed = (track: EngineTrack) =>
    track.artistNames.some((name) => seedCredits.has(normalizeArtistName(name)));

  for (const entry of contributors) {
    const all = dedupeTracks(
      entry.artist.tracks.filter(
        (track) => passesFilters(track, constraints) && !creditsSeed(track),
      ),
    );

    // A guest verse on somebody else's record is the wrong way to meet an
    // artist, and it reads as an incoherent pick besides: choosing Megan Thee
    // Stallion and playing a Maroon 5 single looks like the playlist wandered
    // off, whoever the feature belongs to. Guest spots are kept only for
    // artists who have nothing else to offer.
    const own = entry.artist.name
      ? all.filter(
          (track) =>
            normalizeArtistName(track.artistNames[0] ?? "") ===
            normalizeArtistName(entry.artist.name),
        )
      : all;

    const usable = own.length > 0 ? own : all;
    if (usable.length === 0) continue;

    const picked = selectTracksForBand(usable, trackBand, constraints.maxPerArtist);
    if (picked.length === 0) continue;

    // One queue per artist, merged below rather than concatenated: with more
    // than one track each, concatenation would play every artist's picks
    // back-to-back and no later swap pass can fully unpick that.
    queues.push({
      key: entry.artist.key,
      // The interleave is weighted, so a low-weight artist drifts towards the
      // back and falls off when the list is trimmed to length. This is what
      // actually enforces the band.
      weight: entry.weight,
      items: picked.map((track) => ({
        ...track,
        reason,
      })),
    });

    reserves.push(
      ...usable
        .filter((track) => !picked.includes(track))
        .map((track) => ({ ...track, reason })),
    );
  }

  if (queues.length === 0) {
    return {
      tracks: [],
      warnings: [
        `Artists similar to ${seedArtistName} were found, but none had tracks matching these filters.`,
      ],
    };
  }

  // maxRun 1: never two tracks from the same artist in a row, which matters
  // more here than anywhere else — a run of three reads as "this playlist is
  // about that artist" when it is meant to be about the breadth.
  let tracks = capPerArtist(
    dedupeTracks(interleave(queues, { maxRun: 1 })),
    constraints.maxPerArtist,
  ).slice(0, constraints.targetLength);

  if (tracks.length < constraints.targetLength) {
    const filled = relaxToFill(
      tracks,
      dedupeTracks(reserves).filter((track) => passesFilters(track, constraints)),
      constraints.targetLength,
      constraints.maxPerArtist,
    );
    if (filled.tracks.length > tracks.length && filled.relaxedTo > constraints.maxPerArtist) {
      warnings.push(
        `Not enough similar artists had usable tracks, so up to ${filled.relaxedTo} tracks per artist were allowed.`,
      );
    }
    tracks = filled.tracks.slice(0, constraints.targetLength);
  }

  tracks = separateAdjacent(tracks, (track) => track.artistKey);

  const distinctArtists = new Set(tracks.map((track) => track.artistKey)).size;

  if (tracks.length < constraints.targetLength) {
    warnings.push(
      `Found ${tracks.length} of ${constraints.targetLength} tracks from ${distinctArtists} artists. ` +
        `${seedArtistName} may have a thin similarity graph — try a lower obscurity setting or a better-known starting point.`,
    );
  }

  return { tracks, warnings };
}
