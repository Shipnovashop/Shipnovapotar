import Fastify from "fastify";
import cors from "@fastify/cors";
import { config, corsOrigins } from "./config.js";
import { checkDatabase } from "./db.js";
import { checkRedis } from "./redis.js";
import { registerAuth } from "./auth.js";
import { registerAdminRoutes } from "./admin.js";
import { registerBookingRoutes } from "./bookings.js";
import { registerAssignmentRoutes } from "./assignments.js";
import { registerDriverRoutes } from "./driver.js";
import { registerDeliveryRoutes } from "./delivery.js";
import { registerPaymentRoutes } from "./payments.js";
import { registerNotificationRoutes } from "./notifications.js";
import rawBody from "@fastify/raw-body";
import { ZodError } from "zod";

export async function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  await app.register(rawBody, { field: "rawBody", global: false, runFirst: true });

  await registerAuth(app);
  await registerAdminRoutes(app);
  await registerBookingRoutes(app);
  await registerAssignmentRoutes(app);
  await registerDriverRoutes(app);
  await registerDeliveryRoutes(app);
  await registerPaymentRoutes(app);
  await registerNotificationRoutes(app);

  app.get("/health", async (_request, reply) => {
    const checks = { database: false, redis: false };

    try { checks.database = await checkDatabase(); }
    catch (error) { app.log.error(error, "Database health check failed"); }

    try { checks.redis = await checkRedis(); }
    catch (error) { app.log.error(error, "Redis health check failed"); }

    const healthy = checks.database && checks.redis;
    return reply.code(healthy ? 200 : 503).send({
      success: healthy,
      service: "ShipNovaPortal API",
      status: healthy ? "online" : "degraded",
      checks,
    });
  });

  app.get("/api/v1", async () => ({
    success: true,
    service: "ShipNovaPortal API",
    version: "v1",
  }));

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (error instanceof ZodError) {
      return reply.code(400).send({ success: false, message: "Invalid request data.", issues: error.issues });
    }
    return reply.code(error.statusCode ?? 500).send({
      success: false,
      message: error.statusCode && error.statusCode < 500
        ? error.message
        : "Internal server error.",
    });
  });

  return app;
}
