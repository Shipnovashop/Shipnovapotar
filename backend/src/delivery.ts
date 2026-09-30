import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { db } from "./db.js";

const idSchema = z.object({ id: z.string().uuid() });
const locationSchema = z.object({lat:z.coerce.number().finite().min(-90).max(90),lng:z.coerce.number().finite().min(-180).max(180)});
const OTP_MINUTES = 15;
const MAX_ATTEMPTS = 5;

function trackingCode(){ return `SNTRK-${Date.now().toString(36).toUpperCase()}-${randomInt(1000,10000)}`; }

async function driverProfile(userId:string){ const r=await db.query(`SELECT id FROM driver_profiles WHERE user_id=$1`,[userId]); return r.rows[0]?.id as string|undefined; }

async function getDelivery(id:string){
  return db.query(`SELECT d.*,b.booking_number,b.customer_id,b.status AS booking_status FROM deliveries d JOIN bookings b ON b.id=d.booking_id WHERE d.booking_id=$1`,[id]);
}

export async function registerDeliveryRoutes(app: FastifyInstance){
  app.post("/api/v1/driver/bookings/:id/pickup", {preHandler:app.requireRole(["driver"])}, async(request,reply)=>{
    const {id}=idSchema.parse(request.params); const driverId=await driverProfile(request.user.sub);
    if(!driverId) return reply.code(404).send({success:false,message:"Driver profile not found."});
    const result=await db.query(`UPDATE bookings b SET status='picked_up',updated_at=NOW() FROM booking_assignments a WHERE b.id=$1 AND a.booking_id=b.id AND a.driver_id=$2 AND a.status='accepted' AND b.status='driver_accepted' RETURNING b.id`,[id,driverId]);
    if(!result.rowCount) return reply.code(409).send({success:false,message:"Booking is not ready for pickup."});
    await db.query(`UPDATE deliveries SET started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE booking_id=$1`,[id]);
    await db.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,note) VALUES($1,$2,'picked_up','Package picked up')`,[id,driverId]);
    return reply.send({success:true,message:"Pickup confirmed."});
  });

  app.post("/api/v1/driver/bookings/:id/out-for-delivery", {preHandler:app.requireRole(["driver"])}, async(request,reply)=>{
    const {id}=idSchema.parse(request.params); const driverId=await driverProfile(request.user.sub);
    if(!driverId) return reply.code(404).send({success:false,message:"Driver profile not found."});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const r=await client.query(`UPDATE bookings b SET status='out_for_delivery',updated_at=NOW() FROM booking_assignments a WHERE b.id=$1 AND a.booking_id=b.id AND a.driver_id=$2 AND a.status='accepted' AND b.status='picked_up' RETURNING b.id`,[id,driverId]);
      if(!r.rowCount){await client.query("ROLLBACK");return reply.code(409).send({success:false,message:"Booking is not ready for out-for-delivery."});}
      const otp=String(randomInt(100000,1000000));
      const hash=await bcrypt.hash(otp,10);
      const existing=await client.query(`SELECT tracking_code FROM deliveries WHERE booking_id=$1 FOR UPDATE`,[id]);
      const code=existing.rows[0]?.tracking_code || trackingCode();
      await client.query(`INSERT INTO deliveries(booking_id,driver_id,tracking_code,otp_hash,otp_expires_at,started_at) VALUES($1,$2,$3,$4,NOW()+($5||' minutes')::interval,COALESCE((SELECT started_at FROM deliveries WHERE booking_id=$1),NOW())) ON CONFLICT(booking_id) DO UPDATE SET driver_id=$2,tracking_code=$3,otp_hash=$4,otp_expires_at=NOW()+($5||' minutes')::interval,otp_attempts=0,otp_verified_at=NULL,updated_at=NOW()`,[id,driverId,code,hash,OTP_MINUTES]);
      await client.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,note) VALUES($1,$2,'out_for_delivery','Package is out for delivery')`,[id,driverId]);
      await client.query("COMMIT");
      return reply.send({success:true,message:"Out-for-delivery started.",trackingCode:code,deliveryOtp:otp,otpExpiresInMinutes:OTP_MINUTES});
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  });

  app.post("/api/v1/driver/bookings/:id/deliver", {preHandler:app.requireRole(["driver"])}, async(request,reply)=>{
    const {id}=idSchema.parse(request.params); const {otp}=z.object({otp:z.string().regex(/^\d{6}$/)}).parse(request.body); const driverId=await driverProfile(request.user.sub);
    if(!driverId) return reply.code(404).send({success:false,message:"Driver profile not found."});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const r=await client.query(`SELECT d.*,b.status AS booking_status FROM deliveries d JOIN bookings b ON b.id=d.booking_id WHERE d.booking_id=$1 AND d.driver_id=$2 FOR UPDATE`,[id,driverId]);
      if(!r.rowCount || r.rows[0].booking_status!=="out_for_delivery"){await client.query("ROLLBACK");return reply.code(409).send({success:false,message:"Booking is not ready for delivery."});}
      const d=r.rows[0];
      if(d.otp_attempts>=MAX_ATTEMPTS){await client.query("ROLLBACK");return reply.code(429).send({success:false,message:"Maximum OTP attempts exceeded."});}
      if(!d.otp_hash || !d.otp_expires_at || new Date(d.otp_expires_at).getTime()<Date.now()){await client.query("ROLLBACK");return reply.code(410).send({success:false,message:"Delivery OTP has expired."});}
      const valid=await bcrypt.compare(otp,d.otp_hash);
      if(!valid){await client.query(`UPDATE deliveries SET otp_attempts=otp_attempts+1,updated_at=NOW() WHERE id=$1`,[d.id]);await client.query("COMMIT");return reply.code(401).send({success:false,message:"Invalid delivery OTP."});}
      await client.query(`UPDATE deliveries SET otp_verified_at=NOW(),delivered_at=NOW(),updated_at=NOW() WHERE id=$1`,[d.id]);
      await client.query(`UPDATE bookings SET status='delivered',delivered_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);
      await client.query(`UPDATE driver_profiles SET status='available',updated_at=NOW() WHERE id=$1`,[driverId]);
      await client.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,note) VALUES($1,$2,'delivered','Delivery completed with OTP verification')`,[id,driverId]);
      await client.query("COMMIT");
      return reply.send({success:true,message:"Delivery completed successfully."});
    }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;}finally{client.release();}
  });

  app.patch("/api/v1/driver/bookings/:id/location", {preHandler:app.requireRole(["driver"])}, async(request,reply)=>{
    const {id}=idSchema.parse(request.params); const input=locationSchema.parse(request.body); const driverId=await driverProfile(request.user.sub);
    if(!driverId) return reply.code(404).send({success:false,message:"Driver profile not found."});
    const allowed=await db.query(`SELECT 1 FROM booking_assignments WHERE booking_id=$1 AND driver_id=$2 AND status='accepted'`,[id,driverId]);
    if(!allowed.rowCount)return reply.code(403).send({success:false,message:"This booking is not assigned to you."});
    await db.query(`UPDATE driver_profiles SET current_location=ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,last_location_at=NOW(),updated_at=NOW() WHERE id=$3`,[input.lng,input.lat,driverId]);
    await db.query(`INSERT INTO delivery_events(booking_id,driver_id,event_type,latitude,longitude) VALUES($1,$2,'location_updated',$3,$4)`,[id,driverId,input.lat,input.lng]);
    return reply.send({success:true,message:"Delivery location updated."});
  });

  app.get("/api/v1/bookings/:id/tracking", {preHandler:app.requireRole(["customer","driver","admin"])}, async(request,reply)=>{
    const {id}=idSchema.parse(request.params);
    const base=await db.query(`SELECT b.id,b.booking_number,b.customer_id,b.status,b.pickup_address,b.drop_address,b.vehicle_type,b.total_fare,d.tracking_code,d.driver_id,u.full_name AS driver_name,u.phone AS driver_phone,ST_Y(dp.current_location::geometry) AS driver_lat,ST_X(dp.current_location::geometry) AS driver_lng,dp.last_location_at FROM bookings b LEFT JOIN deliveries d ON d.booking_id=b.id LEFT JOIN driver_profiles dp ON dp.id=d.driver_id LEFT JOIN users u ON u.id=dp.user_id WHERE b.id=$1`,[id]);
    if(!base.rowCount)return reply.code(404).send({success:false,message:"Booking not found."});
    const row=base.rows[0];
    if(request.user.role==='customer' && row.customer_id!==request.user.sub)return reply.code(403).send({success:false,message:"You do not have access to this booking."});
    if(request.user.role==='driver'){const pid=await driverProfile(request.user.sub);if(row.driver_id!==pid)return reply.code(403).send({success:false,message:"You do not have access to this booking."});}
    const events=await db.query(`SELECT event_type,note,latitude,longitude,created_at FROM delivery_events WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 50`,[id]);
    return reply.send({success:true,tracking:{...row,events:events.rows}});
  });
}
