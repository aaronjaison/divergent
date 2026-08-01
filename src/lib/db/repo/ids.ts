import { customAlphabet } from "nanoid";

/**
 * App-generated ids rather than DB autoincrement: keeps the Postgres cutover
 * mechanical and lets us build object graphs before touching the database.
 * Alphabet excludes look-alike characters since playlist ids appear in URLs.
 */
const alphabet = "0123456789abcdefghijkmnpqrstuvwxyz";

export const newId = customAlphabet(alphabet, 16);
/** Shorter, still ~2.6e15 combinations — plenty for shareable playlist URLs. */
export const newPublicId = customAlphabet(alphabet, 10);
