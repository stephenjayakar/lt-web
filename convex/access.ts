import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { isAllowedEmail, userAllowed as isUserAllowed } from "./lib/access";

// For HTTP actions, which can't read the database directly:
//   if (!(await ctx.runQuery(internal.access.userAllowed, { userId }))) -> 403
export const userAllowed = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await isUserAllowed(ctx, userId),
});

/** The signed-in allowlisted user, or null. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user || !isAllowedEmail(user.email)) return null;
    return { userId: user._id, email: user.email ?? null, name: user.name ?? null };
  },
});

/** Public: which sign-in options this deployment offers (fake login is dev-only). */
export const environment = query({
  args: {},
  handler: async () => ({
    google: !!process.env.AUTH_GOOGLE_ID && !!process.env.AUTH_GOOGLE_SECRET,
    fakeLogin: process.env.AUTH_FAKE_LOGIN === "true" && !!process.env.AUTH_FAKE_LOGIN_SECRET,
  }),
});
