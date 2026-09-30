import { Pool } from "pg";
import { config } from "./config.js";

export const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function checkDatabase() {
  const result = await db.query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}
