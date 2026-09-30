import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("7d"),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PHONE: z.string().min(7).max(20).optional(),
  ADMIN_PASSWORD: z.string().min(8).max(128).optional(),
  ADMIN_NAME: z.string().min(2).max(120).default("ShipNovaPortal Admin"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export const config = schema.parse(process.env);

export const corsOrigins = config.CORS_ORIGINS
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
