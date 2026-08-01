/**
 * Environment configuration, read once at module load.
 *
 * Deliberately not zod-validated at import time: a missing optional key should
 * degrade a feature, not crash the server on boot. The one genuinely required
 * value (contact email) has a loud fallback instead, because MusicBrainz
 * throttles anonymous User-Agents rather than rejecting them outright.
 */

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function flag(key: string, fallback = false): boolean {
  const raw = env(key);
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export const config = {
  appName: env("APP_USER_AGENT_NAME", "Divergent"),
  appVersion: env("APP_VERSION", "0.1.0"),
  contactEmail: env("APP_CONTACT_EMAIL", "unset-contact@example.com"),
  baseUrl: env("APP_BASE_URL", "http://localhost:3000"),
  databaseFile: env("DATABASE_FILE", "./data/app.sqlite"),

  providers: {
    deezerEnabled: flag("PROVIDER_DEEZER_ENABLED", true),
    lastfmEnabled: flag("PROVIDER_LASTFM_ENABLED", false),
    lastfmApiKey: env("LASTFM_API_KEY"),
  },

  /**
   * Flipped to true once a MetaBrainz supporter tier is active. MusicBrainz
   * core data is CC0, but genres/tags/ratings are CC BY-NC-SA, so until then
   * tag rows are written as 'noncommercial' and the purge script can clear
   * them. See scripts/purge-noncommercial.ts.
   */
  metabrainzCommercialLicense: flag("METABRAINZ_COMMERCIAL_LICENSE", false),
} as const;

/**
 * MusicBrainz requires this exact shape: "AppName/version ( contact )".
 * A generic or absent User-Agent gets rate-limited harder or blocked outright.
 */
export function userAgent(): string {
  return `${config.appName}/${config.appVersion} ( ${config.contactEmail} )`;
}
