import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";

const assignmentInput = z.object({ bookingId: z.string().uuid(), driverId: z.string().uuid() });
const nearbyInput = z.object({ bookingId: z.string().uuid(), radiusKm: z.coerce.number().min(0.5).max(100).default(15) });

async function assign(app: FastifyInstance, bookingId: string, driverId: string, adminId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const booking = await client.query(`SELECT id,status,vehicle_type,pickup_location FROM bookings WHERE id=$1 FOR UPDATE`, [bookingId]);
    if (!booking.rowCount) throw Object.assign(new Error("Booking not found."), { statusCode: 404 });
    if (!["requested","searching_driver","driver_assigned"].includes(booking.rows[0].status)) throw Object.assign(new Error("Booking cannot be assigned at its current status."), { statusCode: 409 });
    const driver = await client.query(
      `SELECT dp.id FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
       WHERE dp.id=$1 AND u.role='driver' AND u.status='active' AND dp.is_verified=true AND dp.status='available'
       AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id=dp.id AND v.is_active=true AND v.vehicle_type=$2) FOR UPDATE`,
      [driverId, booking.rows[0].vehicle_type],
    );
    if (!driver.rowCount) throw Object.assign(new Error("Driver is not available for this vehicle type."), { statusCode: 409 });
    const distance = await client.query(
      `SELECT ST_Distance(dp.current_location, $1::geography)/1000 AS distance_km FROM driver_profiles dp WHERE dp.id=$2`,
      [booking.rows[0].pickup_location, driverId],
    );
    const distanceKm = distance.rows[0]?.distance_km == null ? null : Number(Number(distance.rows[0].distance_km).toFixed(2));
    await client.query(`UPDATE booking_assignments SET status='cancelled',updated_at=NOW() WHERE booking_id=$1 AND status IN ('pending','accepted')`, [bookingId]);
    await client.query(`INSERT INTO booking_assignments(booking_id,driver_id,status,assigned_by,distance_km) VALUES($1,$2,'pending',$3,$4)`, [bookingId,driverId,adminId,distanceKm]);
    await client.query(`UPDATE bookings SET status='driver_assigned',updated_at=NOW() WHERE id=$1`, [bookingId]);
    await client.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,note) VALUES($1,$2,'driver_assigned','Driver assigned to booking')`, [bookingId,driverId]);
    await client.query("COMMIT");
    return { distanceKm };
  } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; } finally { client.release(); }
}

export async function registerAssignmentRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/assignments/nearby", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const input = nearbyInput.parse(request.query);
    const booking = await db.query(`SELECT pickup_location,vehicle_type,status FROM bookings WHERE id=$1`, [input.bookingId]);
    if (!booking.rowCount) return reply.code(404).send({success:false,message:"Booking not found."});
    const result = await db.query(
      `SELECT dp.id AS driver_id,u.id AS user_id,u.full_name,u.phone,dp.status,dp.is_verified,
              ST_Distance(dp.current_location,b.pickup_location)/1000 AS distance_km,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id',v.id,'vehicleType',v.vehicle_type,'registrationNumber',v.registration_number)) FILTER (WHERE v.id IS NOT NULL),'[]') AS vehicles
       FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
       CROSS JOIN (SELECT pickup_location,vehicle_type FROM bookings WHERE id=$1) b
       LEFT JOIN vehicles v ON v.driver_id=dp.id AND v.is_active=true
       WHERE u.status='active' AND dp.is_verified=true AND dp.status='available' AND dp.current_location IS NOT NULL
         AND ST_DWithin(dp.current_location,b.pickup_location,$2*1000)
         AND EXISTS (SELECT 1 FROM vehicles vx WHERE vx.driver_id=dp.id AND vx.is_active=true AND vx.vehicle_type=b.vehicle_type)
       GROUP BY dp.id,u.id,b.pickup_location
       ORDER BY distance_km ASC LIMIT 50`,
      [input.bookingId, input.radiusKm],
    );
    return reply.send({success:true,drivers:result.rows});
  });

  app.post("/api/v1/admin/assignments", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const input = assignmentInput.parse(request.body);
    const result = await assign(app,input.bookingId,input.driverId,request.user.sub);
    return reply.code(201).send({success:true,message:"Driver assigned.",assignment:result});
  });

  app.post("/api/v1/admin/assignments/auto", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const { bookingId, radiusKm } = z.object({bookingId:z.string().uuid(),radiusKm:z.coerce.number().min(0.5).max(100).default(15)}).parse(request.body);
    const result = await db.query(
      `SELECT dp.id AS driver_id, ST_Distance(dp.current_location,b.pickup_location)/1000 AS distance_km
       FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
       CROSS JOIN (SELECT pickup_location,vehicle_type FROM bookings WHERE id=$1) b
       WHERE u.status='active' AND dp.is_verified=true AND dp.status='available' AND dp.current_location IS NOT NULL
         AND ST_DWithin(dp.current_location,b.pickup_location,$2*1000)
         AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id=dp.id AND v.is_active=true AND v.vehicle_type=b.vehicle_type)
       ORDER BY distance_km ASC LIMIT 1`, [bookingId,radiusKm]);
    if (!result.rowCount) return reply.code(404).send({success:false,message:"No suitable nearby driver found."});
    const assignment = await assign(app,bookingId,result.rows[0].driver_id,request.user.sub);
    return reply.code(201).send({success:true,message:"Nearest driver assigned.",driverId:result.rows[0].driver_id,assignment});
  });
}
