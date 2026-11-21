import type {IncomingHttpHeaders} from "node:http";
import type {FastifyInstance, FastifyRequest} from "fastify";
import proxy from "@fastify/http-proxy";
import type {Pool} from "pg";
import type {ClientOptions} from "ws";
import {HttpError, member} from "./auth";
import {h3WorkerFor} from "./h3-editor";

type H3Request = FastifyRequest & {h3Origin?: string};
const WORKSPACE_PATH = /^\/h3-editor\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/**
 * The H3 Editor page and its API under the application origin, so the Film Studio iframe does not
 * depend on the worker's cross-origin URL. The page is served under
 * /h3-editor/<workspaceId>/h3take/editor; its assets, /view media and /ws socket follow the same
 * prefix (the editor computes it from location.pathname), and every request is authorized by the
 * current workspace membership. The worker origin is selected per request, never cached globally.
 */
export async function h3EditorProxyRoutes(app: FastifyInstance, pool: Pool, publicOrigin: string) {
  function forwardHeaders(headers: IncomingHttpHeaders, origin?: string) {
    if (origin) headers.origin = origin;
    delete headers.cookie;
    delete headers.authorization;
    return headers;
  }

  app.get("/h3-editor/:workspaceId/h3take/editor", async (request, reply) => {
    const {workspaceId} = request.params as {workspaceId: string};
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new HttpError(400, "Unknown workspace");
    await member(pool, request, workspaceId);
    const origin = await h3WorkerFor(pool, workspaceId);
    const response = await fetch(`${origin}/h3take/editor`, {headers: {accept: "text/html"}, signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new HttpError(502, "The H3 Editor page is not available");
    const prefix = `/h3-editor/${workspaceId}`;
    /* The upstream page hard-codes /h3take/editor-files/... absolute asset URLs; move them under
       the workspace prefix. The editor's own JS builds the same prefix for API, media and socket. */
    const html = (await response.text()).replace(/="\/h3take\//g, `="${prefix}/h3take/`);
    return reply.header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html; charset=utf-8")
      .send(html);
  });

  const wsOptions: ClientOptions & {rewriteRequestHeaders: (headers: IncomingHttpHeaders, request: FastifyRequest) => IncomingHttpHeaders} = {
    rewriteRequestHeaders(_headers, request) {
      return {origin: (request as H3Request).h3Origin};
    },
  };
  await app.register(async scope => {
    forwardMultipart(scope);
    await scope.register(proxy, {
      prefix: "/h3-editor/:workspaceId",
      rewritePrefix: "/",
      upstream: "",
      websocket: true,
      preHandler(request, reply, done) {
        void (async () => {
          try {
            const path = (request.raw.url ?? "").split("?", 1)[0];
            const workspaceId = WORKSPACE_PATH.exec(path)?.[1];
            if (!workspaceId) throw new HttpError(401, "Open the H3 Editor from a workspace");
            await member(pool, request, workspaceId);
            if (request.headers.upgrade?.toLowerCase() === "websocket" && request.headers.origin !== publicOrigin)
              throw new HttpError(403, "WebSocket origin is not allowed");
            (request as H3Request).h3Origin = await h3WorkerFor(pool, workspaceId);
            done();
          } catch (error) {
            if (error instanceof HttpError) return reply.code(error.statusCode).send({error: error.message});
            return reply.code(502).send({error: "The H3 Editor is not reachable"});
          }
        })();
      },
      replyOptions: {
        getUpstream(request) {
          const origin = (request as H3Request).h3Origin;
          if (!origin) throw new HttpError(503, "No authorized H3 worker");
          return origin;
        },
        rewriteRequestHeaders(request, headers) {
          return forwardHeaders(headers, (request as H3Request).h3Origin);
        },
        rewriteHeaders(headers) {
          delete headers["set-cookie"];
          return {...headers, "x-content-type-options": "nosniff"};
        },
      },
      wsClientOptions: wsOptions,
    });
  });
}

/* The app reads uploads itself (@fastify/multipart), whose parser leaves a multipart body unread; the proxy then sent
   the editor an empty body, and every upload from the Film Studio (Add sound, voice, video import, cast picture)
   failed with "Could not find starting boundary". Inside the proxy's scope the body goes through as the raw stream. */
export function forwardMultipart(scope: FastifyInstance) {
  scope.removeContentTypeParser("multipart/form-data");
  scope.addContentTypeParser("multipart/form-data", (_request, payload, done) => done(null, payload));
}
