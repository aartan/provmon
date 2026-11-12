
import { z } from "zod";

/**
 * Typed environment access. Fails fast at startup when required variables
 * are missing instead of throwing deep inside request handling.
 *
 * Next.js loads `.env` natively; the worker process and scripts load it via
 * `dotenv/config` (see `worker.ts`). `.env` is never committed.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 characters"),
  AUTH_TRUST_HOST: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default(""),
  DEV_SMTP_HOST: z.string().default("localhost"),
  DEV_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  // Directory containing external retailer plugin packages. Each plugin
  // declares its own environment variables in provmon.plugin.json.
  PROVMON_PLUGIN_DIR: z.string().default("plugins"),
  // Optional comma-separated allowlist of plugin package names, overriding
  // the plugins/provmon.plugins.json list.
  PROVMON_PLUGINS: z.string().default(""),
  // Delay between catalogue discovery pages. The public retailer APIs rate
  // limit bursts, so discovery yields between page jobs.
  CATALOGUE_PAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
  // Optional comma-separated allowlist for retailer catalogue management.
  // When empty, any authenticated user may manage discovery.
  CATALOGUE_ADMIN_EMAILS: z.string().default(""),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Log to stderr directly: the structured logger depends on this module.
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
