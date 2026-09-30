import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { config } from "./config.js";

export async function ensureAdminUser() {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PHONE || !config.ADMIN_PASSWORD) return;

  const email = config.ADMIN_EMAIL.toLowerCase();
  const phone = config.ADMIN_PHONE.replace(/[\s()-]/g, "");
  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);

  const existing = await db.query("SELECT id FROM users WHERE LOWER(email) = $1 OR phone = $2 LIMIT 1", [email, phone]);
  if (existing.rowCount) {
    await db.query(
      `UPDATE users SET role = 'admin', email = $1, phone = $2, full_name = $3,
       password_hash = $4, status = 'active', updated_at = NOW() WHERE id = $5`,
      [email, phone, config.ADMIN_NAME, passwordHash, existing.rows[0].id],
    );
    return;
  }

  await db.query(
    `INSERT INTO users (role, phone, email, full_name, password_hash, status)
     VALUES ('admin', $1, $2, $3, $4, 'active')`,
    [phone, email, config.ADMIN_NAME, passwordHash],
  );
}
