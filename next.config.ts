import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app must run as a single long-lived Node process: the per-provider rate
  // limiters and the in-process generation job queue are module-scoped state, and
  // SQLite needs a persistent disk. Serverless targets would run parallel copies,
  // each believing it owns the full 1 req/s MusicBrainz budget.
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
