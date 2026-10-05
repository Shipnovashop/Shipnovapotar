import { Redis } from "ioredis";
import { config } from "./config.js";

export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

export async function checkRedis(): Promise<boolean> {
  if (redis.status === "wait") {
    await redis.connect();
  }

  return (await redis.ping()) === "PONG";
}