import { schema } from "@flowcarbon/db";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RouteDeps } from "../app";
import { requireUser } from "../auth/principal";
import { avatarUrl, imageType } from "../avatars";
import { notFound, unprocessable } from "../errors";
import { errorResponses, uuid } from "../schemas";

/** largest picture accepted, after the browser has cropped and resized it */
const MAX_BYTES = 200 * 1024;

/** People's pictures: set and removed by their owner, shown to anyone signed in (a versioned, cacheable URL). */
export const avatarRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.put(
    "/me/avatar",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["auth"],
        summary: "Set your picture: a JPEG, PNG or WebP image as a data URL, at most 200 KB",
        body: z.object({ image: z.string().max(400_000) }),
        response: { 200: z.object({ avatarUrl: z.string() }), ...errorResponses },
      },
    },
    async (req) => {
      const u = requireUser(req);
      const base64 = /^data:image\/[a-z+]+;base64,(.+)$/.exec(req.body.image)?.[1];
      const data = base64 ? Buffer.from(base64, "base64") : null;
      const mime = data ? imageType(data) : null;
      if (!data || !mime) throw unprocessable("That is not a JPEG, PNG or WebP picture.");
      if (data.length > MAX_BYTES) throw unprocessable("The picture is too large; at most 200 KB.");
      const now = new Date();
      await db
        .insert(schema.userAvatars)
        .values({ userId: u.userId, mime, data, updatedAt: now })
        .onConflictDoUpdate({ target: schema.userAvatars.userId, set: { mime, data, updatedAt: now } });
      await db.update(schema.users).set({ avatarAt: now }).where(eq(schema.users.id, u.userId));
      return { avatarUrl: avatarUrl(u.userId, now)! };
    },
  );

  app.delete(
    "/me/avatar",
    {
      schema: {
        tags: ["auth"],
        summary: "Remove your picture; your initials show again",
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const u = requireUser(req);
      await db.delete(schema.userAvatars).where(eq(schema.userAvatars.userId, u.userId));
      await db.update(schema.users).set({ avatarAt: null }).where(eq(schema.users.id, u.userId));
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/avatars/:userId",
    {
      schema: {
        tags: ["auth"],
        summary: "A person's picture (signed-in callers only)",
        params: z.object({ userId: uuid }),
        querystring: z.object({ v: z.string().max(20).optional() }),
      },
    },
    async (req, reply) => {
      requireUser(req);
      const [row] = await db
        .select({ mime: schema.userAvatars.mime, data: schema.userAvatars.data })
        .from(schema.userAvatars)
        .where(eq(schema.userAvatars.userId, req.params.userId));
      if (!row) throw notFound("Picture");
      // the URL changes with every new picture, so a copy can be kept for good
      reply
        .header("content-type", row.mime)
        .header("cache-control", req.query.v ? "private, max-age=31536000, immutable" : "private, no-cache")
        .header("content-security-policy", "default-src 'none'; sandbox");
      return reply.send(row.data);
    },
  );
};
