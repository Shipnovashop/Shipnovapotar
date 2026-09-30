import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import Razorpay from "razorpay";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";

const paymentInput = z.object({ method: z.enum(["cod", "online"]) });
const idParam = z.object({ id: z.string().uuid() });
const statusInput = z.object({ status: z.enum(["paid", "failed", "refunded"]), reason: z.string().trim().max(500).optional() });

function razorpayClient() {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({ key_id: config.RAZORPAY_KEY_ID, key_secret: config.RAZORPAY_KEY_SECRET });
}


function safeSignatureEqual(expected: string, actual: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function invoiceNumber() {
  return `SNP-INV-${new Date().toISOString().slice(0,10).replace(/-/g, "")}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function createInvoice(paymentId: string) {
  const existing = await db.query("SELECT * FROM invoices WHERE payment_id = $1", [paymentId]);
  if (existing.rowCount) return existing.rows[0];
  const result = await db.query(`
    INSERT INTO invoices (payment_id, booking_id, customer_id, invoice_number, amount, currency)
    SELECT p.id, p.booking_id, p.customer_id, $2, p.amount, p.currency
    FROM payments p WHERE p.id = $1
    RETURNING *`, [paymentId, invoiceNumber()]);
  return result.rows[0] ?? null;
}

async function markPaymentPaid(paymentId: string, providerPaymentId?: string, signature?: string) {
  const result = await db.query(`
    UPDATE payments SET status='paid', provider_payment_id=COALESCE($2, provider_payment_id),
      provider_signature=COALESCE($3, provider_signature), paid_at=COALESCE(paid_at, NOW()), updated_at=NOW()
    WHERE id=$1 AND status <> 'refunded' RETURNING *`, [paymentId, providerPaymentId ?? null, signature ?? null]);
  if (!result.rowCount) return null;
  return createInvoice(paymentId);
}

export async function registerPaymentRoutes(app: FastifyInstance) {
  app.post("/api/v1/bookings/:id/payment", { preHandler: app.requireRole(["customer"]) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { method } = paymentInput.parse(request.body);
    const booking = await db.query(`SELECT id, total_fare, customer_id, status FROM bookings WHERE id=$1`, [id]);
    if (!booking.rowCount) return reply.code(404).send({ success:false, message:"Booking not found." });
    if (booking.rows[0].customer_id !== request.user.sub) return reply.code(403).send({ success:false, message:"You do not have access to this booking." });
    if (booking.rows[0].status === "cancelled") return reply.code(409).send({ success:false, message:"Cancelled booking cannot be paid." });

    const existing = await db.query("SELECT * FROM payments WHERE booking_id=$1", [id]);
    if (existing.rowCount && existing.rows[0].status === "paid") return reply.send({ success:true, payment: existing.rows[0] });

    const amount = Number(booking.rows[0].total_fare);
    if (method === "cod") {
      const result = await db.query(`
        INSERT INTO payments (booking_id, customer_id, method, status, amount, currency, provider)
        VALUES ($1,$2,'cod','pending',$3,'INR','cod')
        ON CONFLICT (booking_id) DO UPDATE SET method='cod', updated_at=NOW()
        RETURNING *`, [id, request.user.sub, amount]);
      return reply.code(201).send({ success:true, payment: result.rows[0] });
    }

    const client = razorpayClient();
    if (!client) return reply.code(503).send({ success:false, message:"Online payments are not configured on the server." });
    const order = await client.orders.create({ amount: Math.round(amount * 100), currency:"INR", receipt: booking.rows[0].id });
    const result = await db.query(`
      INSERT INTO payments (booking_id, customer_id, method, status, amount, currency, provider, provider_order_id)
      VALUES ($1,$2,'online','pending',$3,'INR','razorpay',$4)
      ON CONFLICT (booking_id) DO UPDATE SET provider_order_id=EXCLUDED.provider_order_id, amount=EXCLUDED.amount, updated_at=NOW()
      RETURNING *`, [id, request.user.sub, amount, order.id]);
    return reply.code(201).send({
      success:true,
      payment: result.rows[0],
      razorpay: { keyId: config.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency },
    });
  });

  app.get("/api/v1/bookings/:id/payment", { preHandler: app.requireRole(["customer", "admin"]) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const result = await db.query(`
      SELECT p.*, i.invoice_number, i.issued_at FROM payments p
      LEFT JOIN invoices i ON i.payment_id=p.id WHERE p.booking_id=$1`, [id]);
    if (!result.rowCount) return reply.code(404).send({ success:false, message:"Payment not found." });
    if (request.user.role === "customer" && result.rows[0].customer_id !== request.user.sub) return reply.code(403).send({ success:false, message:"You do not have access to this payment." });
    return reply.send({ success:true, payment: result.rows[0] });
  });

  app.post("/api/v1/payments/verify", { preHandler: app.requireRole(["customer"]) }, async (request, reply) => {
    const input = z.object({ razorpayOrderId:z.string().min(1), razorpayPaymentId:z.string().min(1), razorpaySignature:z.string().min(1) }).parse(request.body);
    if (!config.RAZORPAY_KEY_SECRET) return reply.code(503).send({ success:false, message:"Razorpay is not configured." });
    const payment = await db.query(`SELECT * FROM payments WHERE provider_order_id=$1 AND customer_id=$2`, [input.razorpayOrderId, request.user.sub]);
    if (!payment.rowCount) return reply.code(404).send({ success:false, message:"Payment order not found." });
    const expected = crypto.createHmac("sha256", config.RAZORPAY_KEY_SECRET).update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`).digest("hex");
    if (!safeSignatureEqual(expected, input.razorpaySignature)) return reply.code(400).send({ success:false, message:"Invalid payment signature." });
    const invoice = await markPaymentPaid(payment.rows[0].id, input.razorpayPaymentId, input.razorpaySignature);
    return reply.send({ success:true, message:"Payment verified successfully.", invoice });
  });

  app.get("/api/v1/invoices/:id", { preHandler: app.requireRole(["customer", "admin"]) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const result = await db.query(`SELECT i.*, b.booking_number, b.pickup_address, b.drop_address, p.method, p.status FROM invoices i JOIN bookings b ON b.id=i.booking_id JOIN payments p ON p.id=i.payment_id WHERE i.id=$1`, [id]);
    if (!result.rowCount) return reply.code(404).send({ success:false, message:"Invoice not found." });
    if (request.user.role === "customer" && result.rows[0].customer_id !== request.user.sub) return reply.code(403).send({ success:false, message:"You do not have access to this invoice." });
    return reply.send({ success:true, invoice: result.rows[0] });
  });

  app.get("/api/v1/admin/payments", { preHandler: app.requireRole(["admin"]) }, async (_request, reply) => {
    const result = await db.query(`SELECT p.*, b.booking_number, u.full_name AS customer_name, u.phone AS customer_phone, i.invoice_number FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN users u ON u.id=p.customer_id LEFT JOIN invoices i ON i.payment_id=p.id ORDER BY p.created_at DESC LIMIT 500`);
    return reply.send({ success:true, payments: result.rows });
  });

  app.patch("/api/v1/admin/payments/:id/status", { preHandler: app.requireRole(["admin"]) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = statusInput.parse(request.body);
    const result = await db.query(`UPDATE payments SET status=$1, failure_reason=$2, paid_at=CASE WHEN $1='paid' THEN COALESCE(paid_at,NOW()) ELSE paid_at END, updated_at=NOW() WHERE id=$3 RETURNING *`, [input.status, input.reason ?? null, id]);
    if (!result.rowCount) return reply.code(404).send({ success:false, message:"Payment not found." });
    const invoice = input.status === "paid" ? await createInvoice(id) : null;
    return reply.send({ success:true, payment: result.rows[0], invoice });
  });

  app.post("/api/v1/payment/webhook", { config: { rawBody: true } }, async (request, reply) => {
    if (!config.RAZORPAY_WEBHOOK_SECRET) return reply.code(503).send({ success:false, message:"Webhook secret is not configured." });
    const signature = String(request.headers["x-razorpay-signature"] ?? "");
    const raw = (request as FastifyRequestWithRawBody).rawBody;
    if (!raw || !signature) return reply.code(400).send({ success:false, message:"Invalid webhook request." });
    const expected = crypto.createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
    if (!safeSignatureEqual(expected, signature)) return reply.code(400).send({ success:false, message:"Invalid webhook signature." });
    const body = JSON.parse(raw.toString("utf8")) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
    const event = body.event;
    const entity = body.payload?.payment?.entity;
    if ((event === "payment.captured" || event === "order.paid") && entity?.order_id && entity.id) {
      const p = await db.query("SELECT id FROM payments WHERE provider_order_id=$1", [entity.order_id]);
      if (p.rowCount) await markPaymentPaid(p.rows[0].id, entity.id);
    }
    if (event === "payment.failed" && entity?.order_id) {
      await db.query("UPDATE payments SET status='failed', failure_reason=COALESCE($2,'Payment failed'), updated_at=NOW() WHERE provider_order_id=$1 AND status <> 'paid'", [entity.order_id, "Razorpay reported payment failure"]);
    }
    return reply.send({ success:true });
  });
}

type FastifyRequestWithRawBody = { rawBody?: Buffer };
