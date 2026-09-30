import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./db.js";

const idSchema = z.object({ id: z.string().uuid() });

export async function createNotification(input: {
  userId: string;
  type: string;
  title: string;
  message: string;
  bookingId?: string | null;
}) {
  const result = await db.query(
    `INSERT INTO notifications (user_id, type, title, message, booking_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.userId, input.type, input.title, input.message, input.bookingId ?? null],
  );
  return result.rows[0];
}

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get("/api/v1/notifications", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await db.query(
      `SELECT id, type, title, message, booking_id, is_read, created_at, read_at
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [request.user.sub],
    );
    return reply.send({ success: true, notifications: result.rows });
  });

  app.get("/api/v1/notifications/unread-count", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await db.query("SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND is_read=FALSE", [request.user.sub]);
    return reply.send({ success: true, count: result.rows[0]?.count ?? 0 });
  });

  app.patch("/api/v1/notifications/:id/read", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idSchema.parse(request.params);
    const result = await db.query(
      `UPDATE notifications SET is_read=TRUE, read_at=COALESCE(read_at,NOW())
       WHERE id=$1 AND user_id=$2 RETURNING *`, [id, request.user.sub],
    );
    if (!result.rowCount) return reply.code(404).send({ success: false, message: "Notification not found." });
    return reply.send({ success: true, notification: result.rows[0] });
  });

  app.patch("/api/v1/notifications/read-all", { preHandler: app.authenticate }, async (request, reply) => {
    const result = await db.query(
      `UPDATE notifications SET is_read=TRUE, read_at=COALESCE(read_at,NOW())
       WHERE user_id=$1 AND is_read=FALSE`, [request.user.sub],
    );
    return reply.send({ success: true, updated: result.rowCount ?? 0 });
  });
}
