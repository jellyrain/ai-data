import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { imageAttachmentLimits } from "@ai-data/contracts";
import type { ApiAuthService, ApiDependencies } from "../app-types";
import type { AuthContext } from "../auth/auth-types";
import { bearerToken } from "./auth-routes";

/** 原始图片请求体限定在附件插件内，认证先于读取正文；其余接口保持 JSON 上限。 */
function registerAttachmentRoutes(
  app: FastifyInstance,
  auth: ApiAuthService,
  attachments: ApiDependencies["attachments"],
): void {
  void app.register(async (scope) => {
    const contexts = new WeakMap<FastifyRequest, AuthContext>();
    scope.addHook("onRequest", async (request) => {
      contexts.set(request, await auth.loadContext(bearerToken(request)));
    });
    scope.addContentTypeParser(
      ["image/png", "image/jpeg", "image/webp"],
      { parseAs: "buffer", bodyLimit: imageAttachmentLimits.fileBytes },
      (_request, body, done) => done(null, body),
    );
    scope.put(
      "/conversations/:conversation/attachments/:id",
      { bodyLimit: imageAttachmentLimits.fileBytes },
      async (request, reply) => {
        const { conversation, id } = z
          .object({ conversation: z.string().min(1).max(128), id: z.uuid() })
          .strict()
          .parse(request.params);
        const { name } = z
          .object({ name: z.string().trim().min(1).max(255) })
          .strict()
          .parse(request.query);
        const bytes = z.instanceof(Buffer).parse(request.body);
        return reply
          .code(201)
          .send(
            await attachments.upload(
              contexts.get(request)!,
              conversation,
              id,
              name,
              String(request.headers["content-type"]).split(";")[0]!,
              bytes,
            ),
          );
      },
    );
    scope.get("/attachments/:id", async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).strict().parse(request.params);
      const result = await attachments.read(contexts.get(request)!, id);
      return reply
        .type(result.metadata.mime_type)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(result.bytes);
    });
    scope.delete("/attachments/:id", async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).strict().parse(request.params);
      await attachments.remove(contexts.get(request)!, id);
      return reply.code(204).send();
    });
  });
}
export { registerAttachmentRoutes };
