import type { Imprint } from "./content/legal.js";
import { MAINTAINER } from "./content/site.js";

/**
 * The imprint's contact data for the build (site/build.ts). Address, phone,
 * email and VAT ID never go into the repository (AGENTS.md, git): they live in
 * `.dev.vars`, where the pre-commit secret scan also guards them. The name is
 * the maintainer's, already public in site/content/site.ts.
 *
 * `pnpm site:deploy` builds with `--release` and refuses a site without them;
 * `pnpm site:dev` shows the missing names in their place.
 */

export const IMPRINT_VARS = {
  street: "SITE_IMPRINT_STREET",
  city: "SITE_IMPRINT_CITY",
  phone: "SITE_IMPRINT_PHONE",
  email: "SITE_IMPRINT_EMAIL",
  vatId: "SITE_IMPRINT_VAT_ID",
} as const satisfies Record<Exclude<keyof Imprint, "name">, string>;

export function readImprint(setting: (name: string) => string, release: boolean): Imprint {
  const missing = Object.values(IMPRINT_VARS).filter((name) => !setting(name));
  if (missing.length > 0) {
    if (release) throw new Error(`The imprint needs ${missing.join(", ")} in .dev.vars (.env.example).`);
    console.warn(`site: ${missing.join(", ")} missing in .dev.vars; the imprint shows placeholders.`);
  }
  const value = (name: string) => setting(name) || name;
  return {
    name: MAINTAINER.name,
    street: value(IMPRINT_VARS.street),
    city: value(IMPRINT_VARS.city),
    phone: value(IMPRINT_VARS.phone),
    email: value(IMPRINT_VARS.email),
    vatId: value(IMPRINT_VARS.vatId),
  };
}
