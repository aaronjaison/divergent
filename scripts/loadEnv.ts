import fs from "node:fs";
import path from "node:path";

/**
 * Next.js loads .env files itself, but standalone scripts run outside it.
 * Uses Node's built-in loader (20.6+) so we don't need dotenv.
 */
export function loadEnv(): void {
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}
