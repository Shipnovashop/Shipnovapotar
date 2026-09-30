import "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

export type AppRole = "customer" | "driver" | "admin";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireRole: (roles: AppRole[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: AppRole; phone: string };
    user: { sub: string; role: AppRole; phone: string };
  }
}
