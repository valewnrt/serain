import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { textArray, type Sql } from "./db.js";
import { HttpError, cookieName, randomToken, readCookie, sessionCookie, sha256Hex, type Env } from "./http.js";

/**
 * Sign-in only with a passkey, only for the owner (D49).
 *
 * - No password, no mail link, no account with a third party. A passkey is
 *   bound to this domain (phishing goes nowhere) and requires Touch ID or the
 *   device code (`userVerification: required`).
 * - A new passkey only against a one-time code the owner creates on their own
 *   computer (`pnpm web enroll`, valid for 15 minutes). The database function
 *   consumes it; without it the worker could not register a passkey.
 * - Session: 32 random bytes in the cookie (HttpOnly, SameSite=Strict, `__Host-`),
 *   in the database only as SHA-256. At most 12 hours, over after 30 minutes
 *   of inactivity. Changes to the vault require a passkey confirmation that is
 *   at most 5 minutes old.
 * - Challenges live in the database and are deleted when checked: each one counts once.
 */

export const SESSION_MAX_SECONDS = 12 * 60 * 60;
const SESSION_IDLE_MINUTES = 30;
export const REAUTH_SECONDS = 5 * 60;
const CHALLENGE_MINUTES = 5;

export interface Session {
  tokenHash: string;
  passkeyId: string;
  /** Seconds since the last confirmation by passkey. */
  verifiedAgo: number;
}

export async function loadSession(sql: Sql, request: Request, env: Env): Promise<Session | null> {
  const token = readCookie(request, cookieName(env));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const rows = await sql<{ passkey_id: string; verified_ago: number; seen_ago: number }[]>`
    select passkey_id,
           extract(epoch from now() - verified_at)::float8 as verified_ago,
           extract(epoch from now() - last_seen_at)::float8 as seen_ago
    from public.web_sessions
    where token_hash = ${tokenHash}
      and expires_at > now()
      and last_seen_at > now() - make_interval(mins => ${SESSION_IDLE_MINUTES})
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.seen_ago > 60) await sql`update public.web_sessions set last_seen_at = now() where token_hash = ${tokenHash}`;
  return { tokenHash, passkeyId: row.passkey_id, verifiedAgo: row.verified_ago };
}

async function storeChallenge(sql: Sql, challenge: string, purpose: "register" | "login"): Promise<string> {
  await sql`delete from public.web_challenges where expires_at < now()`;
  const [row] = await sql<{ id: string }[]>`
    insert into public.web_challenges (challenge, purpose, expires_at)
    values (${challenge}, ${purpose}, now() + make_interval(mins => ${CHALLENGE_MINUTES}))
    returning id
  `;
  return row!.id;
}

/** Takes the challenge and deletes it in the same step: a second attempt with the same one fails. */
async function takeChallenge(sql: Sql, id: unknown, purpose: "register" | "login"): Promise<string> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "Challenge fehlt.");
  const [row] = await sql<{ challenge: string }[]>`
    delete from public.web_challenges where id = ${id} and purpose = ${purpose} and expires_at > now() returning challenge
  `;
  if (!row) throw new HttpError(400, "Challenge expired. Please try again.");
  return row.challenge;
}

async function createSession(sql: Sql, env: Env, passkeyId: string): Promise<string> {
  const token = randomToken();
  await sql`delete from public.web_sessions where expires_at < now() or last_seen_at < now() - make_interval(mins => ${SESSION_IDLE_MINUTES})`;
  await sql`
    insert into public.web_sessions (token_hash, passkey_id, expires_at)
    values (${await sha256Hex(token)}, ${passkeyId}, now() + make_interval(secs => ${SESSION_MAX_SECONDS}))
  `;
  return sessionCookie(env, token, SESSION_MAX_SECONDS);
}

export async function enrollmentValid(sql: Sql, token: unknown): Promise<string> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, "The setup code is missing or broken.");
  const hash = await sha256Hex(token);
  const [row] = await sql<{ ok: boolean }[]>`select public.web_enrollment_valid(${hash}) as ok`;
  if (!row?.ok) throw new HttpError(403, "The setup code has expired or was already used. Create a new one: pnpm web enroll");
  return hash;
}

export async function registrationOptions(sql: Sql, env: Env, token: unknown) {
  await enrollmentValid(sql, token);
  const existing = await sql<{ id: string; transports: string[] }[]>`select id, to_jsonb(transports) as transports from public.web_passkeys`;
  const options = await generateRegistrationOptions({
    rpName: "Serain",
    rpID: env.RP_ID,
    userName: "serain",
    userDisplayName: "Serain",
    // Fixed, so every passkey belongs to the same user and the device does not create a second one for the same site.
    userID: new Uint8Array(new TextEncoder().encode("serain-owner")),
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -8, -257],
  });
  return { challengeId: await storeChallenge(sql, options.challenge, "register"), options };
}

export async function verifyRegistration(sql: Sql, env: Env, body: Record<string, unknown>): Promise<string> {
  const tokenHash = await enrollmentValid(sql, body["token"]);
  const expectedChallenge = await takeChallenge(sql, body["challengeId"], "register");
  const label = typeof body["label"] === "string" ? body["label"].trim().slice(0, 100) : "";
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body["response"] as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: env.WEB_ORIGIN,
      expectedRPID: env.RP_ID,
      requireUserVerification: true,
    });
  } catch {
    throw new HttpError(400, "The passkey could not be verified.");
  }
  if (!verification.verified) throw new HttpError(400, "The passkey could not be verified.");
  const credential = verification.registrationInfo.credential;
  const [row] = await sql<{ ok: boolean }[]>`
    select public.web_register_passkey(
      ${tokenHash}, ${credential.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
      ${textArray(sql, credential.transports ?? [])}, ${label}
    ) as ok
  `;
  if (!row?.ok) throw new HttpError(403, "The setup code has been used in the meantime.");
  return createSession(sql, env, credential.id);
}

export async function loginOptions(sql: Sql, env: Env) {
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`select count(*)::int as count from public.web_passkeys`;
  if (count === 0) throw new HttpError(409, "No passkey set up yet. On your own computer: pnpm web enroll");
  // Without a list: the device offers its discoverable passkey itself, and whoever merely asks learns no IDs.
  const options = await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: "required" });
  return { challengeId: await storeChallenge(sql, options.challenge, "login"), options };
}

/** A failed attempt with a passkey that exists. Unknown ones do not go into the audit log, otherwise anyone could fill it. */
export class KnownPasskeyFailure extends HttpError {}

/**
 * Checks a sign-in. With an open session it only confirms again (for the
 * vault), otherwise a new session starts. Returns the Set-Cookie value if any.
 */
export async function verifyLogin(sql: Sql, env: Env, body: Record<string, unknown>, session: Session | null): Promise<{ cookie: string | null; passkeyId: string }> {
  const expectedChallenge = await takeChallenge(sql, body["challengeId"], "login");
  const response = body["response"] as AuthenticationResponseJSON | undefined;
  const id = typeof response?.id === "string" ? response.id : "";
  const [passkey] = await sql<{ id: string; public_key: Uint8Array; counter: string; transports: string[] }[]>`
    select id, public_key, counter, to_jsonb(transports) as transports from public.web_passkeys where id = ${id}
  `;
  if (!passkey) throw new HttpError(401, "Unknown passkey.");
  if (session && session.passkeyId !== passkey.id) throw new KnownPasskeyFailure(401, "A different passkey than in this session.");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response!,
      expectedChallenge,
      expectedOrigin: env.WEB_ORIGIN,
      expectedRPID: env.RP_ID,
      credential: { id: passkey.id, publicKey: new Uint8Array(passkey.public_key), counter: Number(passkey.counter), transports: passkey.transports },
      requireUserVerification: true,
    });
  } catch {
    throw new KnownPasskeyFailure(401, "The passkey could not be verified.");
  }
  if (!verification.verified) throw new KnownPasskeyFailure(401, "The passkey could not be verified.");
  await sql`update public.web_passkeys set counter = ${verification.authenticationInfo.newCounter}, last_used_at = now() where id = ${passkey.id}`;
  if (session) {
    await sql`update public.web_sessions set verified_at = now(), last_seen_at = now() where token_hash = ${session.tokenHash}`;
    return { cookie: null, passkeyId: passkey.id };
  }
  return { cookie: await createSession(sql, env, passkey.id), passkeyId: passkey.id };
}

export async function logout(sql: Sql, env: Env, session: Session): Promise<string> {
  await sql`delete from public.web_sessions where token_hash = ${session.tokenHash}`;
  return sessionCookie(env, "", 0);
}
