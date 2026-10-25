import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Access control for every function and HTTP route. Only the emails in
// ALLOWED_EMAILS (comma-separated env var) may sign in or touch any data.
// Re-checked on every call, so removing an email locks it out immediately.

export const normEmail = (email: string | undefined | null) => (email ?? "").trim().toLowerCase();

export function allowedEmails(): Set<string> {
  return new Set((process.env.ALLOWED_EMAILS ?? "").split(",").map(normEmail).filter(Boolean));
}

export function isAllowedEmail(email: string | undefined | null): boolean {
  const e = normEmail(email);
  return !!e && allowedEmails().has(e);
}

/** True when `userId` exists and its email is allowlisted. */
export async function userAllowed(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return !!user && isAllowedEmail(user.email);
}

/** Throws unless `userId` is an allowlisted user. */
export async function assertOwner(ctx: QueryCtx, userId: Id<"users">): Promise<void> {
  if (!(await userAllowed(ctx, userId))) throw new ConvexError("This account does not have access.");
}

/** The signed-in allowlisted user's id, or throws. Use in every public query/mutation. */
export async function requireOwner(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in to continue.");
  await assertOwner(ctx, userId);
  return userId;
}
