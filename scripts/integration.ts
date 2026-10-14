import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "../src/config/env.js";
import { integrationStore } from "../src/db/integrations.js";
import { setAuditActor } from "../src/db/audit.js";
import { GOOGLE_SCOPES, googleClient, revokeGoogle } from "../src/google/client.js";
import { parseSealKey } from "../src/integrations/seal.js";
import { Integrations } from "../src/integrations/service.js";
import type { CaldavSecret, GoogleSecret, ImapSecret } from "../src/integrations/types.js";
import { iCloudDav } from "../src/calendar/caldav.js";
import { imapAccount, verifySmtp } from "../src/mail/imap.js";
import { ask, askHidden } from "../src/cli/prompt.js";

/**
 * Connect and disconnect credentials (D30). Runs on the owner's computer, not on the server:
 * a password is typed here and a browser opened, and the server has neither a
 * keyboard nor an open port (D10). It writes directly into Supabase, sealed
 * with `SERAIN_INTEGRATION_KEY`; the server reads the credential on its next
 * start.
 *
 *   pnpm integration key                 create a new key (once)
 *   pnpm integration list
 *   pnpm integration connect gmx         mailbox over IMAP/SMTP with known servers (gmx, webde, posteo, mailbox)
 *   pnpm integration connect <name>      mailbox at another provider, servers are asked for
 *   pnpm integration connect serain      Serain's own mailbox, servers are asked for (addendum D31 of 2026-10-08)
 *   pnpm integration connect google      Gmail and Google Calendar
 *   pnpm integration connect icloud      iCloud calendar over CalDAV (D54)
 *   pnpm integration disconnect <id>     delete the credential and all data from it (W13)
 */

type Hosts = Pick<ImapSecret, "imapHost" | "imapPort" | "smtpHost" | "smtpPort">;

/**
 * Known providers. A credential's ID is the name it was connected with, so
 * also the command to reconnect. The mailbox connected first is the main
 * mailbox, no matter which provider (`src/integrations/setup.ts`).
 */
const PRESETS: Record<string, { hosts: Hosts; hint: string[] }> = {
  gmx: {
    hosts: { imapHost: "imap.gmx.net", imapPort: 993, smtpHost: "mail.gmx.net", smtpPort: 587 },
    hint: [
      "GMX: IMAP has to be enabled (Settings > POP3/IMAP). With two-factor login you need an",
      "application-specific password (Security > Application-specific passwords), not your login password.",
    ],
  },
  webde: {
    hosts: { imapHost: "imap.web.de", imapPort: 993, smtpHost: "smtp.web.de", smtpPort: 587 },
    hint: [
      "WEB.DE: IMAP has to be enabled (Settings > POP3/IMAP). With two-factor login you need an",
      "application-specific password, not your login password.",
    ],
  },
  posteo: {
    hosts: { imapHost: "posteo.de", imapPort: 993, smtpHost: "posteo.de", smtpPort: 587 },
    hint: ["Posteo: login password, with two-factor login a password for mail programs."],
  },
  mailbox: {
    hosts: { imapHost: "imap.mailbox.org", imapPort: 993, smtpHost: "smtp.mailbox.org", smtpPort: 465 },
    hint: ["mailbox.org: login password, with two-factor login an app password."],
  },
};

/**
 * Serain's own mailbox is called `serain`, never after the provider: the owner
 * could also connect a mailbox of their own at the same provider, and that
 * would be theirs. Which provider does not matter; the servers are asked for.
 */
const SERAIN_ID = "serain";

/** Name of a credential: becomes the ID and the command for reconnecting, so short and without special characters. */
const NAME = /^[a-z][a-z0-9-]{1,30}$/;

function integrations(): Integrations {
  if (!env.integrationKey) {
    throw new Error("SERAIN_INTEGRATION_KEY is missing in .dev.vars. Create it with: pnpm integration key");
  }
  return new Integrations(integrationStore, parseSealKey(env.integrationKey), {
    google: (secret) => revokeGoogle(secret as GoogleSecret),
  });
}

async function askPort(question: string, fallback: number): Promise<number> {
  const typed = await ask(`${question} [${fallback}]: `);
  const port = typed ? Number(typed) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${typed} is not a port.`);
  return port;
}

async function askHost(question: string, fallback: string | undefined, example: string): Promise<string> {
  const typed = (await ask(fallback ? `${question} [${fallback}]: ` : `${question} (e.g. ${example}): `)).toLowerCase();
  const host = typed || fallback || "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error(`${host || "Nothing"} is not a server name.`);
  return host;
}

/** IMAP and SMTP servers by hand, prefilled with what the credential already has (reconnecting). */
async function askHosts(known: Hosts | null): Promise<Hosts> {
  console.log("The servers are in your provider's help under IMAP and SMTP. Enter takes the value in brackets.");
  const imapHost = await askHost("IMAP server", known?.imapHost, "imap.example.com");
  const imapPort = await askPort("IMAP port (TLS)", known?.imapPort ?? 993);
  const smtpHost = await askHost("SMTP server", known?.smtpHost, "smtp.example.com");
  const smtpPort = await askPort("SMTP port (465 TLS or 587 STARTTLS)", known?.smtpPort ?? 465);
  return { imapHost, imapPort, smtpHost, smtpPort };
}

/** The servers of an already connected IMAP credential, without passing on the password. */
async function knownHosts(service: Integrations, name: string): Promise<Hosts | null> {
  if (!(await service.has(name))) return null;
  try {
    const { imapHost, imapPort, smtpHost, smtpPort } = await service.secret(name, "imap");
    return { imapHost, imapPort, smtpHost, smtpPort };
  } catch {
    return null;
  }
}

async function connectImap(name: string): Promise<void> {
  if (!NAME.test(name) || name === "google" || name === "icloud") {
    throw new Error(`"${name}" does not work as a name: lowercase letters, digits and hyphen, not google or icloud.`);
  }
  const service = integrations();
  const serains = name === SERAIN_ID;
  const preset = PRESETS[name];
  if (serains) console.log("Serain's own mailbox: from here Serain writes as itself, sender \"Serain\", never in your name.");
  else if (!preset) console.log(`No known provider "${name}" (known: ${Object.keys(PRESETS).join(", ")}, google, icloud). A custom mailbox under this name.`);
  const hosts = preset ? preset.hosts : await askHosts(await knownHosts(service, name));
  const address = (await ask("Mail address: ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(address)) throw new Error("That is not a mail address.");
  for (const line of preset?.hint ?? []) console.log(line);
  const password = await askHidden("Password (not shown): ");
  if (!password) throw new Error("No password entered.");
  const secret: ImapSecret = { kind: "imap", user: address, password, ...hosts, ...(serains ? { owner: "serain" as const } : {}) };

  // Check first, then store: a credential that does not work should not be in the database. IMAP and SMTP,
  // because Serain's mailbox is mostly about sending.
  const probe = imapAccount(name, address, secret);
  try {
    await probe.newSince(null, 1);
  } finally {
    await probe.close();
  }
  await verifySmtp(secret);
  await service.connect({ id: name, account: address, scopes: ["imap:read", "smtp:send"], secret });
  console.log(`Connected: ${name} (${address}). IMAP and SMTP checked. Serain reads the credential on its next start.`);
}

/** Loopback redirect (RFC 8252): the code arrives on 127.0.0.1, nowhere else. */
function receiveCode(clientId: string, verifier: string, state: string): Promise<{ code: string; redirect: string }> {
  return new Promise((resolve, reject) => {
    let redirect = "";
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") return void response.writeHead(404).end();
      const done = (message: string) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(message);
        server.close();
      };
      if (url.searchParams.get("state") !== state) {
        done("Wrong state. Aborted.");
        return reject(new Error("OAuth response with wrong state."));
      }
      const received = url.searchParams.get("code");
      if (!received) {
        done("Declined. You can close the window.");
        return reject(new Error(`Google declined: ${url.searchParams.get("error") ?? "unknown"}`));
      }
      done("Connected. You can close the window.");
      resolve({ code: received, redirect });
    });
    server.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      console.log("Sign in to Google in the browser and agree. If it does not open:");
      console.log(authUrl.toString());
      spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
    });
    setTimeout(() => {
      server.close();
      reject(new Error("No response from Google after 5 minutes."));
    }, 300_000).unref();
  });
}

async function connectGoogle(): Promise<void> {
  const service = integrations();
  const clientId = process.env["GOOGLE_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"]?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing in .dev.vars (OAuth client of type \"Desktop app\", see deploy/README.md).",
    );
  }
  const verifier = randomBytes(48).toString("base64url");
  const received = await receiveCode(clientId, verifier, randomBytes(24).toString("base64url"));

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: received.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: received.redirect,
      code_verifier: verifier,
    }),
  });
  const tokens = (await tokenResponse.json()) as { refresh_token?: string; scope?: string; error_description?: string };
  if (!tokenResponse.ok || !tokens.refresh_token) {
    throw new Error(`Google delivered no refresh token: ${tokens.error_description ?? tokenResponse.status}`);
  }
  const secret: GoogleSecret = { kind: "google", clientId, clientSecret, refreshToken: tokens.refresh_token };
  const granted = (tokens.scope ?? "").split(" ").filter(Boolean);
  const missing = GOOGLE_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    await revokeGoogle(secret).catch(() => undefined);
    throw new Error(`Not all permissions granted, nothing stored. Missing: ${missing.join(", ")}`);
  }
  const profile = await googleClient(secret).request<{ emailAddress: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  );
  await service.connect({ id: "google", account: profile.emailAddress, scopes: granted, secret });
  console.log(`Connected: google (${profile.emailAddress}). Serain reads the credential on its next start.`);
}

async function connectICloud(): Promise<void> {
  const service = integrations();
  const user = (await ask("Apple ID (mail address): ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(user)) throw new Error("That is not a mail address.");
  console.log("Serain needs an app-specific password, never your Apple ID password: account.apple.com >");
  console.log("Sign-In and Security > App-Specific Passwords > \"Serain\". You can revoke it there at any time.");
  const password = await askHidden("App-specific password (not shown): ");
  if (!password) throw new Error("No password entered.");

  // Check first, then store: login, calendar list and one query have to work.
  const dav = iCloudDav({ user, password });
  const calendars = await dav.calendars();
  if (calendars.length === 0) throw new Error("iCloud shows no event calendar. Nothing stored.");
  calendars.forEach((calendar, index) => console.log(`  ${index + 1}. ${calendar.name}`));
  console.log("Serain picks the fitting calendar per event. Which one is the default when none fits better?");
  const picked = calendars.length === 1 ? 1 : Number(await ask("Number: "));
  const target = calendars[picked - 1];
  if (!target) throw new Error("Not a valid number, nothing stored.");
  const now = new Date();
  await dav.query(target.url, { start: now.toISOString(), end: new Date(now.getTime() + 86_400_000).toISOString() });

  const secret: CaldavSecret = { kind: "caldav", user, password, writeCalendarUrl: target.url };
  await service.connect({ id: "icloud", account: user, scopes: ["caldav:read", "caldav:write"], secret });
  console.log(`Connected: icloud (${user}), ${calendars.length} calendars, default "${target.name}".`);
  console.log("Serain reads the credential on its next start (systemctl restart serain).");
}

async function main(): Promise<void> {
  setAuditActor("cli");
  const [command, target] = process.argv.slice(2);
  if (command === "key") {
    console.log("Enter into .dev.vars and /etc/serain/serain.env (the same value, otherwise the server cannot open anything):");
    console.log(`SERAIN_INTEGRATION_KEY=${randomBytes(32).toString("base64")}`);
    return;
  }
  if (command === "list") {
    const rows = await integrations().list();
    if (rows.length === 0) console.log("No credential connected.");
    for (const row of rows) console.log(`${row.id}\t${row.kind}\t${row.account}\t${row.scopes.join(" ")}`);
    return;
  }
  if (command === "connect" && target === "google") return connectGoogle();
  if (command === "connect" && target === "icloud") return connectICloud();
  if (command === "connect" && target) return connectImap(target);
  if (command === "disconnect" && target) {
    const typed = await ask(
      `This deletes the credential "${target}" and everything Serain remembered from its mails. Type "${target}" to confirm: `,
    );
    if (typed !== target) throw new Error("Not confirmed, nothing deleted.");
    const result = await integrations().disconnect(target, "cli");
    if (!result.existed) return void console.log(`There is no credential "${target}".`);
    const revoke =
      result.revoked === null
        ? "."
        : result.revoked
          ? ", token revoked at Google."
          : ", revocation at Google failed: please remove it at myaccount.google.com/permissions.";
    // An app-specific password cannot be revoked by API, only at Apple itself.
    if (target === "icloud") console.log("Revoke the app-specific password at account.apple.com > App-Specific Passwords.");
    console.log(`Disconnected: ${target}. ${result.mailItems} remembered mail entries deleted${revoke}`);
    console.log("Restart Serain so the tools disappear (systemctl restart serain).");
    return;
  }
  console.log("pnpm integration key | list | connect <gmx|webde|posteo|mailbox|name> | connect serain | connect google | connect icloud | disconnect <id>");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
