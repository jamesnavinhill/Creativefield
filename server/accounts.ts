/* Hosted accounts: sign-up and sign-in through Supabase Auth, email+password or Google/GitHub.
   The server holds SUPABASE_URL and SUPABASE_ANON_KEY; the browser never sees them. A Supabase access
   token is checked at Supabase itself (/auth/v1/user), then linked to a CreativeField user:
   - a supabase_id we know: a session for that user;
   - an email we know but not linked: refused (no takeover by email);
   - otherwise the signed-in guest is claimed: their email and supabase_id are set, their workspace stays.
   The Comfy key is unrelated and stays in the browser (cloud-keys.ts). */
import type { Pool } from "pg";
import { HttpError, GUEST_DOMAIN, type Principal } from "./auth";

export type SupabaseAuthConfig = { url: string; anonKey: string };
export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = typeof OAUTH_PROVIDERS[number];

export function supabaseAuthConfig(env: NodeJS.ProcessEnv = process.env): SupabaseAuthConfig | undefined {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, ""), anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey || !/^https:\/\/[^\s/]+$/.test(url)) return undefined;
  return { url, anonKey };
}

type SupabaseUser = { id: string; email: string };
/** Binds a redirect (Google, GitHub, email link) to the browser that started it. */
export const STATE_COOKIE = "cf_account_state";
type Fetch = typeof fetch;

async function supabase(config: SupabaseAuthConfig, path: string, init: RequestInit, fetcher: Fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetcher(`${config.url}${path}`, { ...init, headers: { apikey: config.anonKey, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new HttpError(503, "The sign-in service is not reachable. Try again in a moment."); }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = String(body.msg ?? body.error_description ?? body.message ?? "");
    if (response.status === 400 && /invalid login/i.test(message)) throw new HttpError(401, "Email or password is incorrect");
    if (/not confirmed/i.test(message)) throw new HttpError(401, "Confirm your email first: open the link we sent you.");
    if (/already registered/i.test(message)) throw new HttpError(409, "This email already has an account. Sign in instead.");
    if (response.status === 429) throw new HttpError(429, "Too many attempts. Try again in a minute.");
    throw new HttpError(response.status >= 500 ? 503 : 400, message ? message.slice(0, 200) : "Sign-in failed");
  }
  return body;
}

/** Checks an access token at Supabase and returns its user. */
export async function verifySupabaseToken(config: SupabaseAuthConfig, accessToken: string, fetcher: Fetch = fetch): Promise<SupabaseUser> {
  if (!accessToken || accessToken.length > 4096) throw new HttpError(401, "Sign-in expired. Try again.");
  const body = await supabase(config, "/auth/v1/user", { headers: { authorization: `Bearer ${accessToken}` } }, fetcher).catch(error => {
    throw error instanceof HttpError && error.statusCode !== 503 ? new HttpError(401, "Sign-in expired. Try again.") : error;
  });
  const id = String(body.id ?? ""), email = String(body.email ?? "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !email.includes("@")) throw new HttpError(401, "This sign-in has no email address.");
  if (!body.email_confirmed_at && !body.confirmed_at) throw new HttpError(401, "Confirm your email first: open the link we sent you.");
  return { id, email };
}

/** Email + password. Sign-up may need the emailed link first: then there is no token yet. */
export async function passwordAuth(config: SupabaseAuthConfig, mode: "signup" | "signin", email: string, password: string, redirectTo: string, fetcher: Fetch = fetch): Promise<{ accessToken?: string }> {
  const body = mode === "signup"
    ? await supabase(config, `/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, { method: "POST", body: JSON.stringify({ email, password }) }, fetcher)
    : await supabase(config, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) }, fetcher);
  const token = typeof body.access_token === "string" ? body.access_token : undefined;
  return { accessToken: token };
}

export function oauthUrl(config: SupabaseAuthConfig, provider: OAuthProvider, redirectTo: string): string {
  return `${config.url}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;
}

/** Links a verified Supabase user to a CreativeField user and returns who to sign in. */
export async function linkAccount(pool: Pool, current: Principal | undefined, user: SupabaseUser): Promise<Principal> {
  const known = (await pool.query("SELECT id,email FROM users WHERE supabase_id=$1", [user.id])).rows[0];
  if (known) return known;
  /* An existing user is never linked by email alone: that would hand their workspace to whoever owns the Supabase login. */
  if ((await pool.query("SELECT 1 FROM users WHERE email=$1", [user.email])).rowCount) throw new HttpError(409, "This email is already used here. Sign in with the account you made it with.");
  if (current?.email.endsWith(GUEST_DOMAIN)) {
    const claimed = (await pool.query("UPDATE users SET email=$1,supabase_id=$2 WHERE id=$3 RETURNING id,email", [user.email, user.id, current.id])).rows[0];
    if (claimed) return claimed;
  }
  throw new HttpError(409, "Open CreativeField again, then sign in.");
}
