import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  // Per-user key/value store backing saves, persistent records, and
  // achievements. Small values are inline JSON; large ones (EOtF save dicts)
  // live in file storage and are referenced by storageId.
  kv: defineTable({
    userId: v.id("users"),
    key: v.string(),
    value: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    encoding: v.string(), // "json" (inline) | "json" or "gzip-json" (blob)
    size: v.number(), // UTF-8 bytes of the JSON payload
    updatedAt: v.number(),
  }).index("by_user_key", ["userId", "key"]),
});
