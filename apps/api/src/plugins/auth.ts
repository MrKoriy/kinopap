import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import type { UserRole } from "@zal/api-client";
import { unauthorized } from "../lib/http";
import type { Config } from "../config";

export interface AccessPayload {
  sub: number;
  role: UserRole;
  typ: "access";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: AccessPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function registerAuth(
  app: FastifyInstance,
  config: Config,
): Promise<void> {
  await app.register(jwt, { secret: config.jwtSecret });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      if (request.user.typ !== "access") {
        throw unauthorized("Unexpected token type");
      }
    } catch {
      // Не раскрываем причину — просто 401.
      throw unauthorized();
    }
    void reply;
  });
}
