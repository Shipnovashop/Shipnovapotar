import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";

const coordinate = z.coerce.number().finite();
const createBookingSchema = z.object({
  pickupAddress: z.string().trim().min(3).max(500),
  pickupLat: coordinate.min(-90).max(90),
  pickupLng: coordinate.min(-180).max(180),
  dropAddress: z.string().trim().min(3).max(500),
  dropLat: coordinate.min(-90).max(90),
  dropLng: coordinate.min(-180).max(180),
  packageDescription: z.string().trim().min(2).max(500),
  weightKg: z.coerce.number().min(0).max(1000).default(0),
  vehicleType: z.enum(["bike", "auto", "mini_truck", "truck"]).default("bike"),
  customerNote: z.string().trim().max(1000).optional().or(z.literal("")),
});

const listSchema = z.object({
  status: z.enum([
    "requested", "searching_driver", "driver_assigned", "driver_accepted",
    "picked_up", "out_for_delivery", "delivered", "cancelled",
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function bookingNumber() {
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.floor(1000 + Math.random() * 9000);
  return `SNP-${time}-${random}`;
}

function fare(distanceKm: number, weightKg: number, vehicleType: string) {
  const base = vehicleType === "bike" ? 50 : vehicleType === "auto" ? 80 : vehicleType === "mini_truck" ? 140 : 220;
  const rate = vehicleType === "bike" ? 12 : vehicleType === "auto" ? 15 : vehicleType === "mini_truck" ? 20 : 28;
  const weightCharge = Math.max(0, weightKg - 5) * 5;
  const total = Math.max(base, base + distanceKm * rate + weightCharge);
  return { base, rate, weightCharge: Number(weightCharge.toFixed(2)), total: Number(total.toFixed(2)) };
}

function publicBooking(row: Record<string, unknown>) {
  return {
    id: row.id,
    bookingNumber: row.booking_number,
    customerId: row.customer_id,
    pickupAddress: row.pickup_address,
    pickupLat: row.pickup_lat,
    pickupLng: row.pickup_lng,
    dropAddress: row.drop_address,
    dropLat: row.drop_lat,
    dropLng: row.drop_lng,
    packageDescription: row.package_description,
    weightKg: Number(row.weight_kg),
    vehicleType: row.vehicle_type,
    distanceKm: Number(row.distance_km),
    baseFare: Number(row.base_fare),
    perKmRate: Number(row.per_km_rate),
    weightCharge: Number(row.weight_charge),
    totalFare: Number(row.total_fare),
    status: row.status,
    customerNote: row.customer_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    deliveredAt: row.delivered_at,
  };
}

const selectBooking = `
  SELECT b.id, b.booking_number, b.customer_id,
    b.pickup_address, ST_Y(b.pickup_location::geometry) AS pickup_lat, ST_X(b.pickup_location::geometry) AS pickup_lng,
    b.drop_address, ST_Y(b.drop_location::geometry) AS drop_lat, ST_X(b.drop_location::geometry) AS drop_lng,
    b.package_description, b.weight_kg, b.vehicle_type, b.distance_km,
    b.base_fare, b.per_km_rate, b.weight_charge, b.total_fare, b.status,
    b.customer_note, b.created_at, b.updated_at, b.cancelled_at, b.delivered_at
  FROM bookings b
`;

export async function registerBookingRoutes(app: FastifyInstance) {
  app.post("/api/v1/bookings", { preHandler: app.requireRole(["customer"]) }, async (request, reply) => {
    const input = createBookingSchema.parse(request.body);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const customer = await client.query(
        "SELECT id, status FROM users WHERE id = $1 AND role = 'customer' LIMIT 1",
        [request.user.sub],
      );
      if (!customer.rowCount || customer.rows[0].status !== "active") {
        await client.query("ROLLBACK");
        return reply.code(403).send({ success: false, message: "Customer account is not active." });
      }

      const distanceResult = await client.query<{ distance_km: number }>(
        `SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
        ) / 1000 AS distance_km`,
        [input.pickupLng, input.pickupLat, input.dropLng, input.dropLat],
      );
      const distanceKm = Number(Number(distanceResult.rows[0].distance_km).toFixed(2));
      const prices = fare(distanceKm, input.weightKg, input.vehicleType);

      const result = await client.query(
        `INSERT INTO bookings (
          booking_number, customer_id, pickup_address, pickup_location,
          drop_address, drop_location, package_description, weight_kg,
          vehicle_type, distance_km, base_fare, per_km_rate, weight_charge,
          total_fare, status, customer_note
        ) VALUES (
          $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
          $6, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, $9, $10,
          $11, $12, $13, $14, $15, $16, 'requested', $17
        ) RETURNING id`,
        [
          bookingNumber(), request.user.sub, input.pickupAddress, input.pickupLng, input.pickupLat,
          input.dropAddress, input.dropLng, input.dropLat, input.packageDescription, input.weightKg,
          input.vehicleType, distanceKm, prices.base, prices.rate, prices.weightCharge, prices.total,
          input.customerNote || null,
        ],
      );
      await client.query("COMMIT");

      const booking = await db.query(`${selectBooking} WHERE b.id = $1`, [result.rows[0].id]);
      return reply.code(201).send({ success: true, message: "Booking created successfully.", booking: publicBooking(booking.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/v1/bookings", { preHandler: app.requireRole(["customer", "admin"]) }, async (request, reply) => {
    const query = listSchema.parse(request.query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (request.user.role === "customer") {
      params.push(request.user.sub);
      conditions.push(`b.customer_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`b.status = $${params.length}`);
    }
    params.push(query.limit, query.offset);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await db.query(
      `${selectBooking} ${where} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return reply.send({ success: true, bookings: result.rows.map(publicBooking), pagination: { limit: query.limit, offset: query.offset } });
  });

  app.get("/api/v1/bookings/:id", { preHandler: app.requireRole(["customer", "admin"]) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await db.query(`${selectBooking} WHERE b.id = $1`, [params.id]);
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Booking not found." });
    if (request.user.role === "customer" && result.rows[0].customer_id !== request.user.sub) {
      return reply.code(403).send({ success: false, message: "You do not have access to this booking." });
    }
    return reply.send({ success: true, booking: publicBooking(result.rows[0]) });
  });

  app.post("/api/v1/bookings/:id/cancel", { preHandler: app.requireRole(["customer"]) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await db.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND customer_id = $2 AND status IN ('requested', 'searching_driver', 'driver_assigned')
       RETURNING id`,
      [params.id, request.user.sub],
    );
    if (!result.rowCount) return reply.code(409).send({ success: false, message: "Booking cannot be cancelled at its current status." });
    return reply.send({ success: true, message: "Booking cancelled." });
  });
}
