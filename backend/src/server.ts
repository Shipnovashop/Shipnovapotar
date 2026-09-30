import { buildApp } from "./app.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { redis } from "./redis.js";
import { ensureAdminUser } from "./admin-bootstrap.js";

const app = await buildApp();

try {
  await ensureAdminUser();
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  await db.end().catch(() => undefined);
  redis.disconnect();
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await db.end();
  redis.disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
