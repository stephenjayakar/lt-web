import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { assertOwner, requireOwner } from "./lib/access";

// Inline values must stay well under the 1 MiB document limit; anything
// larger goes through the /kv/blob HTTP route into file storage.
const MAX_INLINE_BYTES = 256 * 1024;
// Inline values up to this size are returned by `hydrate` directly.
const HYDRATE_INLINE_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 256;

function checkKey(key: string) {
  if (!key || key.length > MAX_KEY_LENGTH) throw new ConvexError("Invalid key.");
}

async function findEntry(ctx: QueryCtx, userId: Id<"users">, key: string) {
  return await ctx.db
    .query("kv")
    .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
    .unique();
}

async function dropBlob(ctx: MutationCtx, entry: Doc<"kv"> | null, keep?: Id<"_storage">) {
  if (entry?.storageId && entry.storageId !== keep) {
    await ctx.storage.delete(entry.storageId);
  }
}

/** Every key with metadata; small inline values are included for hydration. */
export const hydrate = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireOwner(ctx);
    const entries = await ctx.db
      .query("kv")
      .withIndex("by_user_key", (q) => q.eq("userId", userId))
      .collect();
    return entries.map((e) => ({
      key: e.key,
      size: e.size,
      updatedAt: e.updatedAt,
      blob: e.storageId !== undefined,
      value: e.value !== undefined && e.size <= HYDRATE_INLINE_BYTES ? e.value : undefined,
    }));
  },
});

/** One entry. Blob entries return `blob: true`; fetch them from GET /kv/blob. */
export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await requireOwner(ctx);
    const e = await findEntry(ctx, userId, key);
    if (!e) return null;
    return {
      key: e.key,
      size: e.size,
      updatedAt: e.updatedAt,
      blob: e.storageId !== undefined,
      value: e.value,
    };
  },
});

export const setInline = mutation({
  args: { key: v.string(), value: v.string() },
  handler: async (ctx, { key, value }) => {
    const userId = await requireOwner(ctx);
    checkKey(key);
    const size = new TextEncoder().encode(value).length;
    if (size > MAX_INLINE_BYTES) throw new ConvexError("Value too large for inline storage.");
    const existing = await findEntry(ctx, userId, key);
    const updatedAt = Date.now();
    const fields = { value, storageId: undefined, encoding: "json", size, updatedAt };
    if (existing) {
      await dropBlob(ctx, existing);
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("kv", { userId: userId, key, ...fields });
    }
    return { updatedAt };
  },
});

export const remove = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const userId = await requireOwner(ctx);
    const existing = await findEntry(ctx, userId, key);
    if (!existing) return null;
    await dropBlob(ctx, existing);
    await ctx.db.delete(existing._id);
    return null;
  },
});

// ---- Internal helpers for the /kv/blob HTTP routes (http.ts) ----

export const blobEntry = internalQuery({
  args: { userId: v.id("users"), key: v.string() },
  handler: async (ctx, { userId, key }) => {
    await assertOwner(ctx, userId);
    const e = await findEntry(ctx, userId, key);
    if (!e?.storageId) return null;
    return { storageId: e.storageId, encoding: e.encoding, size: e.size, updatedAt: e.updatedAt };
  },
});

export const commitBlob = internalMutation({
  args: {
    userId: v.id("users"),
    key: v.string(),
    storageId: v.id("_storage"),
    encoding: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { userId, key, storageId, encoding, size }) => {
    await assertOwner(ctx, userId);
    checkKey(key);
    const existing = await findEntry(ctx, userId, key);
    const updatedAt = Date.now();
    const fields = { value: undefined, storageId, encoding, size, updatedAt };
    if (existing) {
      await dropBlob(ctx, existing, storageId);
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("kv", { userId, key, ...fields });
    }
    return { updatedAt };
  },
});
