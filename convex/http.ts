import { getAuthUserId } from "@convex-dev/auth/server";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// CORS: only the game's own origins (SITE_URL, comma-separated).
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const origins = (process.env.SITE_URL ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!origins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-KV-Encoding, X-KV-Size, X-KV-Updated-At",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** The signed-in allowlisted user id, or a 401/403 response. */
async function ownerOrDeny(
  ctx: ActionCtx,
  deny: (status: number, msg: string) => Response,
): Promise<Id<"users"> | Response> {
  const userId = await getAuthUserId(ctx).catch(() => null); // malformed/expired token throws
  if (!userId) return deny(401, "Sign in to continue.");
  if (!(await ctx.runQuery(internal.access.userAllowed, { userId }))) {
    return deny(403, "This account does not have access.");
  }
  return userId;
}

// ---- /kv/blob: large values (multi-MB save dicts) in file storage ----------
// Bypasses the 1 MiB document limit. Requires the Convex Auth JWT as a Bearer
// token; blobs are never exposed through public storage URLs.
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

http.route({
  path: "/kv/blob",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, req) => new Response(null, { status: 204, headers: corsHeaders(req) })),
});

http.route({
  path: "/kv/blob",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const cors = corsHeaders(req);
    const deny = (status: number, msg: string) =>
      new Response(msg, { status, headers: { ...cors, "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    const userId = await ownerOrDeny(ctx, deny);
    if (userId instanceof Response) return userId;
    const key = new URL(req.url).searchParams.get("key") ?? "";
    const entry = await ctx.runQuery(internal.kv.blobEntry, { userId, key });
    if (!entry) return deny(404, "Not found.");
    const blob = await ctx.storage.get(entry.storageId);
    if (!blob) return deny(404, "Blob missing.");
    return new Response(blob, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-KV-Encoding": entry.encoding,
        "X-KV-Size": String(entry.size),
        "X-KV-Updated-At": String(entry.updatedAt),
      },
    });
  }),
});

http.route({
  path: "/kv/blob",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const cors = corsHeaders(req);
    const deny = (status: number, msg: string) =>
      new Response(msg, { status, headers: { ...cors, "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    const userId = await ownerOrDeny(ctx, deny);
    if (userId instanceof Response) return userId;
    const params = new URL(req.url).searchParams;
    const key = params.get("key") ?? "";
    const encoding = params.get("encoding") === "gzip-json" ? "gzip-json" : "json";
    const size = Number(params.get("size") ?? "0");
    if (!key || key.length > 256 || !Number.isFinite(size)) return deny(400, "Bad request.");
    const blob = await req.blob();
    if (blob.size === 0 || blob.size > MAX_BLOB_BYTES) return deny(413, "Blob size out of range.");
    const storageId = await ctx.storage.store(blob);
    try {
      const { updatedAt } = await ctx.runMutation(internal.kv.commitBlob, { userId, key, storageId, encoding, size });
      return new Response(JSON.stringify({ updatedAt }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (err) {
      await ctx.storage.delete(storageId); // never leave an unreferenced blob behind
      return deny(500, err instanceof Error ? err.message : "Commit failed.");
    }
  }),
});

export default http;
