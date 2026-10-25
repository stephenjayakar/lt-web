// Convex transport + Convex Auth session for the browser (no React).
//
// All calls use Convex's HTTP API (`/api/query|mutation|action`), which fails
// fast when offline and lets the write queue in cloud-store.ts own ordering
// and retries. Sign-in is Google OAuth through Convex Auth: `auth:signIn`
// returns a Google redirect plus a PKCE verifier; Google returns to this page
// with `?code=`, which is exchanged for a JWT + refresh token. Tokens live in
// localStorage, so the session survives reloads. Mirrors the approach of
// kanto-spire-rust web/src/net/cloud.js.

export interface CloudUser {
  userId: string;
  email: string | null;
  name: string | null;
}

interface Tokens {
  token: string;
  refreshToken: string;
}

type Kind = 'query' | 'mutation' | 'action';

/** An error from Convex or the network. `network` errors are retryable. */
export class CloudError extends Error {
  network: boolean;
  status: number;
  constructor(message: string, network = false, status = 0) {
    super(message);
    this.network = network;
    this.status = status;
  }
}

function tokenExpiry(jwt: string): number {
  try {
    const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return (JSON.parse(atob(payload)).exp as number) * 1000;
  } catch {
    return 0;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/** Short user-facing message from a Convex error response. */
function convexMessage(body: any, status: number): string {
  if (typeof body?.errorData === 'string') return body.errorData;
  const raw = String(body?.errorMessage ?? body?.message ?? `HTTP ${status}`);
  const m = /Uncaught (?:Convex)?Error: ([^\n]*)/.exec(raw);
  return m ? m[1] : raw.split('\n')[0];
}

export class CloudClient {
  readonly url: string;
  readonly siteUrl: string;
  /** Last sign-in problem, shown on the sign-in screen. */
  error: string | null = null;
  private tokens: Tokens | null;
  private refreshing: Promise<string | null> | null = null;
  private readonly authKey: string;
  private readonly verifierKey: string;

  constructor(url: string, siteUrl: string) {
    this.url = url;
    this.siteUrl = siteUrl;
    const ns = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '');
    this.authKey = `lt-web.auth.v1:${ns}`;
    this.verifierKey = `lt-web.authVerifier.v1:${ns}`;
    this.tokens = readJson<Tokens>(this.authKey);
  }

  hasSession(): boolean {
    return this.tokens !== null;
  }

  private setTokens(tokens: Tokens | null): void {
    this.tokens = tokens ? { token: tokens.token, refreshToken: tokens.refreshToken } : null;
    writeJson(this.authKey, this.tokens);
  }

  /** Raw Convex HTTP call. */
  async post(kind: Kind, path: string, args: unknown, token: string | null, keepalive = false): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${this.url}/api/${kind}`, {
        method: 'POST',
        headers,
        keepalive,
        body: JSON.stringify({ path, args: args ?? {}, format: 'json' }),
      });
    } catch (err) {
      throw new CloudError(`Network error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const body = await res.json().catch(() => null);
    if (!body || body.status !== 'success') {
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408 || !body;
      throw new CloudError(convexMessage(body, res.status), retryable, res.status);
    }
    return body.value;
  }

  /**
   * The current JWT, refreshed when under a minute remains (or when forced).
   * A refresh the server refuses ends the session; a network failure throws
   * and keeps it.
   */
  async freshToken(force = false): Promise<string | null> {
    const tokens = this.tokens;
    if (!tokens) return null;
    if (!force && tokenExpiry(tokens.token) - Date.now() > 60_000) return tokens.token;
    this.refreshing ??= (async () => {
      try {
        const r = await this.post('action', 'auth:signIn', { refreshToken: tokens.refreshToken }, null);
        this.setTokens(r?.tokens ?? null);
      } catch (err) {
        if (err instanceof CloudError && err.network) throw err;
        console.warn('[cloud] token refresh refused', err);
        this.setTokens(null);
      }
      return this.tokens?.token ?? null;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Authenticated call; retries once with a forced refresh on an auth failure. */
  async call(kind: Kind, path: string, args: unknown = {}, keepalive = false): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.freshToken(attempt > 0);
      if (!token) throw new CloudError('Signed out. Sign in with Google again.');
      try {
        return await this.post(kind, path, args, token, keepalive);
      } catch (err) {
        const authFailure = err instanceof CloudError && !err.network && /sign in|unauthenticated|token/i.test(err.message);
        if (attempt === 0 && authFailure) continue;
        throw err;
      }
    }
  }

  /** Authenticated fetch against the deployment's HTTP actions (…convex.site). */
  async fetchSite(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.freshToken(attempt > 0);
      if (!token) throw new CloudError('Signed out. Sign in with Google again.');
      let res: Response;
      try {
        res = await fetch(`${this.siteUrl}${path}`, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        throw new CloudError(`Network error: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      if (res.status === 401 && attempt === 0) continue;
      return res;
    }
  }

  /** Which sign-in options the deployment offers. */
  async environment(): Promise<{ google: boolean; fakeLogin: boolean }> {
    try {
      return await this.post('query', 'access:environment', {}, null);
    } catch {
      return { google: true, fakeLogin: false };
    }
  }

  /**
   * Finish a Google redirect if this page load is one (`?code=`), or note a
   * cancelled sign-in. Strips the code from the URL.
   */
  async completeRedirect(): Promise<void> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const verifier = readJson<string>(this.verifierKey);
    if (code) {
      url.searchParams.delete('code');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      try {
        const r = await this.post('action', 'auth:signIn', { params: { code }, verifier: verifier ?? undefined }, null);
        if (!r?.tokens) throw new Error('no tokens for that code');
        this.setTokens(r.tokens);
        this.error = null;
      } catch (err) {
        console.warn('[cloud] sign-in code exchange failed', err);
        this.error = "Sign-in didn't finish. Please try again.";
      }
      writeJson(this.verifierKey, null);
    } else if (verifier && !this.tokens) {
      // Back without a code: cancelled, or the Google account isn't allowed.
      this.error = 'Sign-in was cancelled or that Google account is not allowed.';
      writeJson(this.verifierKey, null);
    }
  }

  /** Start Google sign-in: navigates away to Google. */
  async signInWithGoogle(): Promise<void> {
    this.error = null;
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    const r = await this.post('action', 'auth:signIn', { provider: 'google', params: { redirectTo: url.toString() } }, null);
    if (!r?.redirect) throw new CloudError('Sign-in could not start.');
    writeJson(this.verifierKey, r.verifier);
    window.location.href = r.redirect;
  }

  /** Dev-deployment test sign-in (AUTH_FAKE_LOGIN + secret). */
  async signInFake(email: string, secret: string): Promise<void> {
    const r = await this.post(
      'action',
      'auth:signIn',
      { provider: 'fake-google', params: { email, secret } },
      null,
    );
    if (!r?.tokens) throw new CloudError('Test sign-in failed.');
    this.setTokens(r.tokens);
    this.error = null;
  }

  /** The signed-in allowlisted user, or null (session invalid / not allowed). */
  async me(): Promise<CloudUser | null> {
    return await this.call('query', 'access:me', {});
  }

  async signOut(): Promise<void> {
    try {
      await this.call('action', 'auth:signOut', {});
    } catch {
      // already signed out
    }
    this.setTokens(null);
  }

  /** Forget the local session (e.g. the server refused this account). */
  dropSession(message: string | null): void {
    this.setTokens(null);
    this.error = message;
  }
}
