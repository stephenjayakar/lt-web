import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { isAllowedEmail, normEmail } from "./lib/access";

const NOT_ALLOWED = "This game's saves are private to its owner.";

// Google sign-in, restricted to ALLOWED_EMAILS with a verified email.
// OAuth redirect URI to register on the Google client:
//   https://<deployment>.convex.site/api/auth/callback/google
const OwnerGoogle = Google({
  profile(p) {
    const email = normEmail(p.email);
    if (!p.email_verified || !isAllowedEmail(email)) throw new ConvexError(NOT_ALLOWED);
    return { id: p.sub, name: p.name, email, image: p.picture };
  },
});

// Dev-only stand-in for Google so automated E2E can sign in. Exists only when
// AUTH_FAKE_LOGIN=true and the caller knows AUTH_FAKE_LOGIN_SECRET; still
// limited to allowlisted emails. Never set these on prod.
const FakeGoogle = ConvexCredentials<DataModel>({
  id: "fake-google",
  authorize: async (params, ctx) => {
    const secret = process.env.AUTH_FAKE_LOGIN_SECRET;
    if (process.env.AUTH_FAKE_LOGIN !== "true" || !secret) {
      throw new ConvexError("Test sign-in is turned off on this deployment.");
    }
    if (String(params.secret ?? "") !== secret) throw new ConvexError("Wrong test sign-in secret.");
    const email = normEmail(String(params.email ?? ""));
    if (!isAllowedEmail(email)) throw new ConvexError(NOT_ALLOWED);
    const { user } = await createAccount(ctx, {
      provider: "fake-google",
      account: { id: email },
      profile: { email },
      shouldLinkViaEmail: true,
    });
    return { userId: user._id };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [OwnerGoogle, FakeGoogle],
  callbacks: {
    // The game is served from several origins (hosted site + localhost), so
    // accept any origin listed in SITE_URL (comma-separated).
    async redirect({ redirectTo }) {
      const origins = (process.env.SITE_URL ?? "")
        .split(",")
        .map((s) => s.trim().replace(/\/$/, ""))
        .filter(Boolean);
      for (const o of origins) {
        if (redirectTo === o || redirectTo.startsWith(o + "/") || redirectTo.startsWith(o + "?")) return redirectTo;
      }
      if (origins[0] && (redirectTo.startsWith("/") || redirectTo.startsWith("?"))) return origins[0] + redirectTo;
      throw new Error(`Invalid redirectTo ${redirectTo}`);
    },
  },
});
