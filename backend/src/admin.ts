import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";

const uuidSchema = z.string().uuid();
const statusSchema = z.enum(["active", "suspended", "blocked"]);
const vehicleSchema = z.object({
  vehicleType: z.string().trim().min(2).max(40),
  registrationNumber: z.string().trim().min(2).max(30),
  make: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  color: z.string().trim().max(40).optional(),
});

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/stats", { preHandler: app.requireRole(["admin"]) }, async (_request, reply) => {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE role = 'customer')::int AS customers,
        COUNT(*) FILTER (WHERE role = 'driver')::int AS drivers,
        COUNT(*) FILTER (WHERE role = 'driver' AND status = 'pending')::int AS pending_drivers,
        COUNT(*) FILTER (WHERE role = 'driver' AND status = 'active')::int AS active_drivers,
        COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_users
      FROM users
    `);
    return reply.send({ success: true, stats: result.rows[0] });
  });

  app.get("/api/v1/admin/customers", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const query = z.object({ search: z.string().trim().max(100).optional() }).parse(request.query);
    const search = query.search ? `%${query.search}%` : null;
    const result = await db.query(`
      SELECT id, phone, email, full_name, status, created_at, updated_at
      FROM users
      WHERE role = 'customer'
        AND ($1::text IS NULL OR phone ILIKE $1 OR COALESCE(email, '') ILIKE $1 OR COALESCE(full_name, '') ILIKE $1)
      ORDER BY created_at DESC
      LIMIT 200
    `, [search]);
    return reply.send({ success: true, customers: result.rows });
  });

  app.patch("/api/v1/admin/customers/:id/status", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const { status } = z.object({ status: statusSchema }).parse(request.body);
    const result = await db.query(`
      UPDATE users SET status = $1, updated_at = NOW()
      WHERE id = $2 AND role = 'customer'
      RETURNING id, phone, email, full_name, status, updated_at
    `, [status, id]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Customer not found." });
    return reply.send({ success: true, customer: result.rows[0] });
  });

  app.get("/api/v1/admin/drivers", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const query = z.object({ status: z.enum(["pending", "active", "suspended", "blocked"]).optional(), search: z.string().trim().max(100).optional() }).parse(request.query);
    const search = query.search ? `%${query.search}%` : null;
    const result = await db.query(`
      SELECT
        u.id, u.phone, u.email, u.full_name, u.status, u.created_at,
        dp.id AS driver_profile_id, dp.status AS driver_status, dp.is_verified,
        COUNT(v.id)::int AS vehicle_count
      FROM users u
      LEFT JOIN driver_profiles dp ON dp.user_id = u.id
      LEFT JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = TRUE
      WHERE u.role = 'driver'
        AND ($1::account_status IS NULL OR u.status = $1::account_status)
        AND ($2::text IS NULL OR u.phone ILIKE $2 OR COALESCE(u.email, '') ILIKE $2 OR COALESCE(u.full_name, '') ILIKE $2)
      GROUP BY u.id, dp.id
      ORDER BY u.created_at DESC
      LIMIT 200
    `, [query.status ?? null, search]);
    return reply.send({ success: true, drivers: result.rows });
  });

  app.patch("/api/v1/admin/drivers/:id/status", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const { status } = z.object({ status: statusSchema }).parse(request.body);
    const result = await db.query(`
      UPDATE users SET status = $1, updated_at = NOW()
      WHERE id = $2 AND role = 'driver'
      RETURNING id, phone, email, full_name, status, updated_at
    `, [status, id]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Driver not found." });
    return reply.send({ success: true, driver: result.rows[0] });
  });

  app.post("/api/v1/admin/drivers/:id/approve", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query(`UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1 AND role = 'driver' RETURNING id, phone, email, full_name, status`, [id]);
      if (!user.rowCount) { await client.query("ROLLBACK"); return reply.code(404).send({ success: false, message: "Driver not found." }); }
      await client.query(`UPDATE driver_profiles SET is_verified = TRUE, updated_at = NOW() WHERE user_id = $1`, [id]);
      await client.query("COMMIT");
      return reply.send({ success: true, message: "Driver approved and verified.", driver: user.rows[0] });
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  });

  app.post("/api/v1/admin/drivers/:id/reject", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const result = await db.query(`UPDATE users SET status = 'suspended', updated_at = NOW() WHERE id = $1 AND role = 'driver' RETURNING id, phone, email, full_name, status`, [id]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Driver not found." });
    return reply.send({ success: true, message: "Driver rejected.", driver: result.rows[0] });
  });

  app.get("/api/v1/admin/drivers/:id/vehicles", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const result = await db.query(`
      SELECT v.* FROM vehicles v
      JOIN driver_profiles dp ON dp.id = v.driver_id
      WHERE dp.user_id = $1 ORDER BY v.created_at DESC
    `, [id]);
    return reply.send({ success: true, vehicles: result.rows });
  });

  app.post("/api/v1/admin/drivers/:id/vehicles", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const input = vehicleSchema.parse(request.body);
    const result = await db.query(`
      INSERT INTO vehicles (driver_id, vehicle_type, registration_number, make, model, color)
      SELECT dp.id, $2, $3, $4, $5, $6
      FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
      WHERE u.id = $1 AND u.role = 'driver'
      RETURNING *
    `, [id, input.vehicleType, input.registrationNumber.toUpperCase(), input.make || null, input.model || null, input.color || null]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Driver not found." });
    return reply.code(201).send({ success: true, vehicle: result.rows[0] });
  });

  app.patch("/api/v1/admin/vehicles/:id/status", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const id = uuidSchema.parse((request.params as { id: string }).id);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(request.body);
    const result = await db.query(`UPDATE vehicles SET is_active = $1 WHERE id = $2 RETURNING *`, [isActive, id]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Vehicle not found." });
    return reply.send({ success: true, vehicle: result.rows[0] });
  });
}
