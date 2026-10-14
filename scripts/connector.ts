import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { signJwt } from "../src/connectors/drivers/enable-banking.js";

/**
 * Setting up the bank connection (D51). Runs on the owner's computer.
 *
 *   pnpm connector bank-key <file.pem> [app-id]
 *       Copy the private key that Enable Banking's control panel downloads when
 *       creating the app (the file name is the app ID) into .dev.vars:
 *       ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY (PEM, base64).
 *   pnpm connector bank-check [search_term]
 *       Asks Enable Banking with this key whether the bank from
 *       ENABLE_BANKING_BANK (country ENABLE_BANKING_COUNTRY, default DE) is
 *       offered, how long an authorization lasts and what details the bank
 *       requires. With a search term: all banks whose name contains it, to find
 *       the exact name for ENABLE_BANKING_BANK.
 */

const ROOT = resolve(import.meta.dirname, "..");
const VARS = join(ROOT, ".dev.vars");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function readVar(name: string): string {
  if (!existsSync(VARS)) return "";
  const line = readFileSync(VARS, "utf8").split("\n").find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

function writeVar(name: string, value: string, comment: string): void {
  const lines = existsSync(VARS) ? readFileSync(VARS, "utf8").split("\n") : [];
  const index = lines.findIndex((entry) => entry.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`# ${comment}`, `${name}=${value}`);
  writeFileSync(VARS, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
}

function bankKey(file: string | undefined, appIdArg: string | undefined): void {
  if (!file) throw new Error("Usage: pnpm connector bank-key <file.pem> [app-id]");
  const pem = readFileSync(file, "utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("This is not an RSA key with at least 2048 bits.");
  const appId = appIdArg ?? UUID.exec(basename(file))?.[0];
  if (!appId || !UUID.test(appId)) throw new Error("App ID missing: pass it as the second argument (it is in the control panel).");
  writeVar("ENABLE_BANKING_APP_ID", appId.toLowerCase(), "Enable Banking (D51): app in Restricted Production mode");
  writeVar("ENABLE_BANKING_KEY", Buffer.from(pem, "utf8").toString("base64"), "Enable Banking (D51): the app's private key, PEM as base64");
  console.log("ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY are in .dev.vars.");
  console.log(`Now delete the downloaded file: rm "${file}"`);
  console.log("For the server: both lines into /etc/serain/serain.env, then deploy.");
}

async function bankCheck(search: string | undefined): Promise<void> {
  const appId = readVar("ENABLE_BANKING_APP_ID");
  const raw = readVar("ENABLE_BANKING_KEY");
  if (!appId || !raw) throw new Error("Run pnpm connector bank-key first.");
  const wanted = readVar("ENABLE_BANKING_BANK");
  const country = (readVar("ENABLE_BANKING_COUNTRY") || "DE").toUpperCase();
  if (!search && !wanted) throw new Error("Neither ENABLE_BANKING_BANK in .dev.vars nor a search term: pnpm connector bank-check <search_term>.");
  const key = createPrivateKey(Buffer.from(raw, "base64").toString("utf8"));
  const response = await fetch(`https://api.enablebanking.com/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`, {
    headers: { authorization: `Bearer ${signJwt(appId, key)}` },
  });
  const data = (await response.json()) as { aspsps?: Array<Record<string, unknown>>; error?: string };
  if (!response.ok) throw new Error(`Enable Banking refuses (${response.status} ${data.error ?? ""}).`);
  const banks = data.aspsps ?? [];
  const needle = (search ?? wanted).toLocaleLowerCase("de");
  const hits = banks.filter((bank) => String(bank["name"]).toLocaleLowerCase("de").includes(needle));
  console.log(`${banks.length} banks for ${country}.`);
  if (hits.length === 0) {
    console.log(`No bank with "${search ?? wanted}" in its name. Without it in the list, the bank connection does not work.`);
    return;
  }
  for (const bank of hits) {
    console.log(`- ${String(bank["name"])}: authorization at most ${Math.round(Number(bank["maximum_consent_validity"]) / 86_400)} days, PSU details: ${JSON.stringify(bank["required_psu_headers"] ?? [])}`);
  }
  if (!wanted) console.log("Enter the exact name as ENABLE_BANKING_BANK in .dev.vars and /etc/serain/serain.env.");
  else if (!hits.some((bank) => bank["name"] === wanted)) console.log(`Note: no bank is called exactly "${wanted}"; set ENABLE_BANKING_BANK to one of the names above.`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "bank-key") bankKey(args[0], args[1]);
  else if (command === "bank-check") await bankCheck(args[0]);
  else {
    console.log("Commands: bank-key <file.pem> [app-id], bank-check [search_term]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
