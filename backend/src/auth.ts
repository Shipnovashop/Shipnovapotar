import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "@fastify/jwt";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";

const registerCustomerSchema = z.object({
  phone: z.string().trim().min(7).max(20),
  email: z.string().trim().email().max(255).optional().or(z.literal("")),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(8).max(128),
});

const registerDriverSchema = registerCustomerSchema;

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(255),
  password: z.string().min(1).max(128),
});

type Role = "customer" | "driver" | "admin";

type TokenPayload = {
  sub: string;
  role: Role;
  phone: string;
};

function normalizePhone(value: string) {
  return value.replace(/[\s()-]/g, "");
}

function normalizeEmail(value?: string) {
  const email = value?.trim().toLowerCase();
  return email || null;
}

function publicUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    role: row.role,
    phone: row.phone,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

async function createToken(app: FastifyInstance, user: { id: string; role: Role; phone: string }) {
  return app.jwt.sign({
    sub: user.id,
    role: user.role,
    phone: user.phone,
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({ success: false, message: "Invalid credentials." });
}

export async function registerAuth(app: FastifyInstance) {
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  });

  app.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, message: "Authentication required." });
    }
  });

  app.decorate("requireRole", (roles: Role[]) => async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ success: false, message: "Authentication required." });
    }

    const role = request.user.role as Role;
    if (!roles.includes(role)) {
      return reply.code(403).send({ success: false, message: "You do not have permission for this resource." });
    }
  });

  app.post("/api/v1/auth/register/customer", async (request, reply) => {
    const input = registerCustomerSchema.parse(request.body);
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, 12);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND LOWER(email) = $2) LIMIT 1",
        [phone, email],
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ success: false, message: "Phone or email is already registered." });
      }

      const result = await client.query(
        `INSERT INTO users (role, phone, email, full_name, password_hash, status)
         VALUES ('customer', $1, $2, $3, $4, 'active')
         RETURNING id, role, phone, email, full_name, status, created_at`,
        [phone, email, input.fullName, passwordHash],
      );
      await client.query("COMMIT");

      const user = result.rows[0];
      const token = await createToken(app, user);
      return reply.code(201).send({ success: true, message: "Customer registered successfully.", token, user: publicUser(user) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/v1/auth/register/driver", async (request, reply) => {
    const input = registerDriverSchema.parse(request.body);
    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, 12);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id FROM users WHERE phone = $1 OR ($2::text IS NOT NULL AND LOWER(email) = $2) LIMIT 1",
        [phone, email],
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ success: false, message: "Phone or email is already registered." });
      }

      const result = await client.query(
        `INSERT INTO users (role, phone, email, full_name, password_hash, status)
         VALUES ('driver', $1, $2, $3, $4, 'pending')
         RETURNING id, role, phone, email, full_name, status, created_at`,
        [phone, email, input.fullName, passwordHash],
      );
      const user = result.rows[0];
      await client.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [user.id]);
      await client.query("COMMIT");

      const token = await createToken(app, user);
      return reply.code(201).send({
        success: true,
        message: "Driver registered. Account approval is required before going online.",
        token,
        user: publicUser(user),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const identifier = input.identifier.trim().toLowerCase();

    const isEmail = input.identifier.includes("@");
    const lookup = isEmail ? identifier : normalizePhone(input.identifier);
    const result = await db.query(
      `SELECT id, role, phone, email, full_name, status, password_hash, created_at
       FROM users
       WHERE ${isEmail ? "LOWER(email) = $1" : "phone = $1"}
       LIMIT 1`,
      [lookup],
    );

    const user = result.rows[0];
    if (!user || !user.password_hash) return unauthorized(reply);

    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) return unauthorized(reply);
    if (user.status === "blocked" || user.status === "suspended") {
      return reply.code(403).send({ success: false, message: "Your account is not active." });
    }

    const token = await createToken(app, user);
    return reply.send({ success: true, token, user: publicUser(user) });
  });

  app.get("/api/v1/auth/me", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await db.query(
      `SELECT id, role, phone, email, full_name, status, created_at
       FROM users WHERE id = $1 LIMIT 1`,
      [request.user.sub],
    );
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "User not found." });
    return reply.send({ success: true, user: publicUser(result.rows[0]) });
  });
}
