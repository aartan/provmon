
import pino from "pino";

import { env } from "@/lib/env";

/**
 * Structured logger. Child loggers should be created with a `component`
 * binding so every line can be attributed: `log.child({ component: "monitoring" })`.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { app: "provmon" },
});
