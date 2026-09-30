import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";

const statusSchema = z.enum(["offline", "available", "busy"]);
const locationSchema = z.object({
  lat: z.coerce.number().finite().min(-90).max(90),
  lng: z.coerce.number().finite().min(-180).max(180),
});
const idSchema = z.object({ id: z.string().uuid() });

async function ensureDriver(app: FastifyInstance, request: any, reply: any) {
  if (request.user.role !== "driver") return reply.code(403).send({ success: false, message: "Driver access required." });
  const result = await db.query(
    `SELECT dp.id, dp.status, dp.is_verified, u.status AS account_status
     FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
     WHERE dp.user_id = $1 LIMIT 1`,
    [request.user.sub],
  );
  if (!result.rowCount) return reply.code(404).send({ success: false, message: "Driver profile not found." });
  const driver = result.rows[0];
  if (driver.account_status !== "active" || !driver.is_verified) {
    return reply.code(403).send({ success: false, message: "Driver is not approved or active." });
  }
  request.driverProfile = driver;
}

export async function registerDriverRoutes(app: FastifyInstance) {
  app.get("/api/v1/driver/me", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const result = await db.query(
      `SELECT dp.id, dp.status, dp.is_verified, dp.last_location_at,
              ST_Y(dp.current_location::geometry) AS lat,
              ST_X(dp.current_location::geometry) AS lng,
              u.id AS user_id, u.full_name, u.phone, u.email, u.status AS account_status,
              COALESCE((SELECT json_agg(v ORDER BY v.created_at DESC) FROM vehicles v WHERE v.driver_id = dp.id), '[]'::json) AS vehicles
       FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE dp.user_id = $1 LIMIT 1`,
      [request.user.sub],
    );
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Driver profile not found." });
    return reply.send({ success: true, driver: result.rows[0] });
  });

  app.patch("/api/v1/driver/me/status", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const { status } = z.object({ status: statusSchema }).parse(request.body);
    const profile = await db.query(
      `SELECT dp.id, dp.is_verified, u.status AS account_status FROM driver_profiles dp JOIN users u ON u.id=dp.user_id WHERE dp.user_id=$1`,
      [request.user.sub],
    );
    if (!profile.rowCount) return reply.code(404).send({ success: false, message: "Driver profile not found." });
    if (profile.rows[0].account_status !== "active" || !profile.rows[0].is_verified) {
      return reply.code(403).send({ success: false, message: "Driver must be approved before changing availability." });
    }
    if (status === "available") {
      const vehicle = await db.query(`SELECT 1 FROM vehicles WHERE driver_id=$1 AND is_active=true LIMIT 1`, [profile.rows[0].id]);
      if (!vehicle.rowCount) return reply.code(409).send({ success: false, message: "Add an active vehicle before going online." });
    }
    const result = await db.query(`UPDATE driver_profiles SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id,status`, [status, profile.rows[0].id]);
    return reply.send({ success: true, driver: result.rows[0] });
  });

  app.patch("/api/v1/driver/me/location", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const input = locationSchema.parse(request.body);
    const profile = await db.query(`SELECT id FROM driver_profiles WHERE user_id=$1`, [request.user.sub]);
    if (!profile.rowCount) return reply.code(404).send({ success: false, message: "Driver profile not found." });
    await db.query(
      `UPDATE driver_profiles SET current_location=ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, last_location_at=NOW(), updated_at=NOW() WHERE id=$3`,
      [input.lng, input.lat, profile.rows[0].id],
    );
    return reply.send({ success: true, message: "Location updated." });
  });

  app.get("/api/v1/driver/assignments", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const profile = await db.query(`SELECT id FROM driver_profiles WHERE user_id=$1`, [request.user.sub]);
    if (!profile.rowCount) return reply.code(404).send({ success: false, message: "Driver profile not found." });
    const result = await db.query(
      `SELECT ba.id, ba.booking_id, ba.status, ba.distance_km, ba.created_at, b.booking_number,
              b.pickup_address, b.drop_address, b.package_description, b.weight_kg, b.vehicle_type,
              b.total_fare, b.status AS booking_status
       FROM booking_assignments ba JOIN bookings b ON b.id=ba.booking_id
       WHERE ba.driver_id=$1 AND ba.status IN ('pending','accepted')
       ORDER BY ba.created_at DESC`,
      [profile.rows[0].id],
    );
    return reply.send({ success: true, assignments: result.rows });
  });

  app.post("/api/v1/driver/assignments/:id/accept", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const profile = await client.query(`SELECT id FROM driver_profiles WHERE user_id=$1 FOR UPDATE`, [request.user.sub]);
      if (!profile.rowCount) return reply.code(404).send({ success:false, message:"Driver profile not found." });
      const assignment = await client.query(`SELECT id, booking_id FROM booking_assignments WHERE id=$1 AND driver_id=$2 AND status='pending' FOR UPDATE`, [id, profile.rows[0].id]);
      if (!assignment.rowCount) { await client.query("ROLLBACK"); return reply.code(409).send({ success:false, message:"Assignment is no longer available." }); }
      const booking = await client.query(`SELECT id,status FROM bookings WHERE id=$1 FOR UPDATE`, [assignment.rows[0].booking_id]);
      if (!booking.rowCount || booking.rows[0].status !== "driver_assigned") { await client.query("ROLLBACK"); return reply.code(409).send({ success:false, message:"Booking is not awaiting driver acceptance." }); }
      await client.query(`UPDATE booking_assignments SET status='accepted',responded_at=NOW(),updated_at=NOW() WHERE id=$1`, [id]);
      await client.query(`UPDATE booking_assignments SET status='cancelled',updated_at=NOW() WHERE booking_id=$1 AND id<>$2 AND status='pending'`, [assignment.rows[0].booking_id, id]);
      await client.query(`UPDATE bookings SET status='driver_accepted',updated_at=NOW() WHERE id=$1`, [assignment.rows[0].booking_id]);
      await client.query(`UPDATE driver_profiles SET status='busy',updated_at=NOW() WHERE id=$1`, [profile.rows[0].id]);
      await client.query(`INSERT INTO deliveries(booking_id,driver_id,tracking_code) VALUES($1,$2,$3) ON CONFLICT(booking_id) DO UPDATE SET driver_id=EXCLUDED.driver_id,updated_at=NOW()`, [assignment.rows[0].booking_id, profile.rows[0].id, `SNTRK-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000+Math.random()*9000)}`]);
      await client.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,note) VALUES($1,$2,'driver_accepted','Driver accepted the delivery')`, [assignment.rows[0].booking_id, profile.rows[0].id]);
      await client.query("COMMIT");
      return reply.send({success:true,message:"Assignment accepted."});
    } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally { client.release(); }
  });

  app.post("/api/v1/driver/assignments/:id/reject", { preHandler: app.requireRole(["driver"]) }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const profile = await db.query(`SELECT id FROM driver_profiles WHERE user_id=$1`, [request.user.sub]);
    if (!profile.rowCount) return reply.code(404).send({success:false,message:"Driver profile not found."});
    const result = await db.query(
      `UPDATE booking_assignments SET status='rejected',responded_at=NOW(),updated_at=NOW() WHERE id=$1 AND driver_id=$2 AND status='pending' RETURNING booking_id`,
      [id, profile.rows[0].id],
    );
    if (!result.rowCount) return reply.code(409).send({success:false,message:"Assignment is no longer available."});
    await db.query(`UPDATE bookings SET status='searching_driver',updated_at=NOW() WHERE id=$1 AND status='driver_assigned'`, [result.rows[0].booking_id]);
    return reply.send({success:true,message:"Assignment rejected."});
  });
}
