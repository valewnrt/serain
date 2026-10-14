import * as z from "zod/mini";

/**
 * A login in the vault (D36, D49). Both sides read this file: the web interface
 * checks before sealing, the server after opening. What the server uses comes
 * only from inside the seal; the plain-text columns in `vault_entries` are for
 * display in the web interface and worthless to the server. Otherwise whoever
 * can change the database could bend the hosts of an entry and have Serain
 * type the owner's password into their own site.
 */

export const SITE_NAME = /^[a-z][a-z0-9_-]{1,30}$/;

const host = z.string().check(z.trim(), z.toLowerCase(), z.regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/, "Host like example.org"));

// zod/mini instead of zod: the same checks, but the web interface loads them too, and classic zod would weigh 450 KB there.
// Without a locale, mini only knows "Invalid input", so every check carries a message of its own.
export const vaultEntrySchema = z
  .strictObject({
    site: z.string("Name missing").check(z.regex(SITE_NAME, "Name of lowercase letters, digits, - and _, 2 to 31 characters")),
    /** Hosts the main site may be on; subdomains count too. */
    hosts: z.array(host, "Hosts missing").check(z.minLength(1, "At least one host"), z.maxLength(5, "At most five hosts")),
    loginUrl: z.url("Login address is not an address").check(z.startsWith("https://", "Login address must start with https://")),
    username: z.string("Username missing").check(z.minLength(1, "Username missing"), z.maxLength(200, "Username is too long")),
    password: z.string("Password missing").check(z.minLength(1, "Password missing"), z.maxLength(500, "Password is too long")),
    /** Base32 as in authenticator apps, without spaces. */
    totpSecret: z.optional(z.string().check(z.regex(/^[A-Z2-7]{16,200}=*$/, "TOTP secret in Base32"))),
  }, "Unknown field")
  .check(
    // A broken address is already reported by `loginUrl`; without the pre-check `new URL` would throw mid-validation.
    z.refine((entry) => !URL.canParse(entry.loginUrl) || hostAllowed(entry, new URL(entry.loginUrl).hostname), {
      message: "The login address is not on one of the allowed hosts.",
      path: ["loginUrl"],
    }),
  );
export type VaultEntry = z.infer<typeof vaultEntrySchema>;

export function hostAllowed(entry: { hosts: readonly string[] }, hostname: string): boolean {
  const name = hostname.toLowerCase();
  return entry.hosts.some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

/** Spaces, hyphens and lowercase, the way sites show TOTP secrets. */
export function normalizeTotpSecret(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}
