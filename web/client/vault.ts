import { sealBytesTo, sealTo } from "../../src/vault/sealbox.js";
import { normalizeTotpSecret, vaultEntrySchema } from "../../src/vault/entry.js";
import { bytesToBase64Url, packVaultFile, sha256Hex, VAULT_FILE_MAX_BYTES, VAULT_FILE_NAME } from "../../src/vault/file.js";
import { cleanFileName, formatSize, MIME_TYPE } from "../../src/files/name.js";
import { api, cached, forget, isFresh, load, message, withReauth } from "./api.js";
import { h, icon } from "./dom.js";
import type { Page } from "./main.js";
import { busy, button, compactDate, confirmDialog, dialog, empty, skeleton, toast } from "./ui.js";

interface VaultRow {
  site: string;
  username: string;
  hosts: string[];
  login_url: string;
  totp: boolean;
  updated_at: string;
}

interface FileRow {
  name: string;
  filename: string;
  mime_type: string;
  size: number;
  updated_at: string;
}

interface Vault {
  publicKey: string;
  keyId: string;
  entries: VaultRow[];
  files: FileRow[];
}

const VIEWS = [
  { slug: "", label: "Logins" },
  { slug: "files", label: "Files" },
] as const;

const PATH = "/api/vault";

export const prefetchVault = () => void load(PATH).catch(() => undefined);

/** Host name without "www.", or empty while the address is not one. */
function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The name the owner uses for the login when talking to Serain: "bahn" for bahn.de, "amazon" for amazon.co.uk. */
function nameFrom(host: string): string {
  const parts = host.split(".");
  const second = parts.length >= 3 && ["co", "com", "org", "net", "gov", "ac"].includes(parts[parts.length - 2]!) ? parts[parts.length - 3] : parts[parts.length - 2];
  const name = (second ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return /^[a-z]/.test(name) ? name.slice(0, 31) : "";
}

type FieldName = "loginUrl" | "site" | "username" | "password" | "hosts" | "totpSecret";

function field(name: FieldName, label: string, input: HTMLInputElement, hint?: HTMLElement | string, trailing?: HTMLElement) {
  const id = `f-${name}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  input.id = id;
  input.name = name;
  input.setAttribute("aria-describedby", `${hint ? `${hintId} ` : ""}${errorId}`);
  const error = h("p", { class: "field-error", id: errorId });
  const wrap = h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    trailing ? h("div", { class: "input-with" }, input, trailing) : input,
    hint ? h("p", { class: "field-hint", id: hintId }, hint) : null,
    error,
  );
  return {
    wrap,
    input,
    setError(text: string) {
      if (text) {
        input.setAttribute("aria-invalid", "true");
        error.replaceChildren(icon("alert"), text);
      } else {
        input.removeAttribute("aria-invalid");
        error.replaceChildren();
      }
    },
  };
}

const textInput = (props: Record<string, unknown>) =>
  h("input", { type: "text", autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false", ...props });

function openForm(vault: Vault, existing: VaultRow | null, done: (site: string) => void): void {
  // No password manager should save or suggest anything here: this goes to Serain, not to this interface.
  const secret = { autocomplete: "off", "data-1p-ignore": "true", "data-lpignore": "true", "data-bwignore": "true" };
  const urlInput = textInput({ type: "url", inputmode: "url", placeholder: "https://www.example.com/login", value: existing?.login_url ?? "" });
  const siteInput = textInput({ placeholder: "example", value: existing?.site ?? "", maxlength: "31" });
  if (existing) siteInput.readOnly = true;
  const userInput = textInput({ value: existing?.username ?? "" });
  const passInput = h("input", { type: "password", ...secret });
  const hostsInput = textInput({ placeholder: "example.com", value: existing?.hosts.join(", ") ?? "" });
  const totpInput = h("input", { type: "password", spellcheck: "false", autocapitalize: "characters", ...secret });

  const reveal = h("button", { type: "button", class: "icon-btn reveal", "aria-label": "Show password", "aria-pressed": "false" }, icon("eye"));
  reveal.addEventListener("click", () => {
    const show = passInput.type === "password";
    passInput.type = show ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(show));
    reveal.setAttribute("aria-label", show ? "Hide password" : "Show password");
    reveal.replaceChildren(icon(show ? "eyeOff" : "eye"));
  });

  const hostHint = h("span");
  const fields = {
    loginUrl: field("loginUrl", "Login address", urlInput, hostHint),
    site: field("site", "Name", siteInput, "What you call it in the chat."),
    username: field("username", "Username or email", userInput),
    password: field("password", "Password", passInput, existing ? "The old one cannot be read, so enter it again." : undefined, reveal),
    hosts: field("hosts", "Allowed hosts", hostsInput, "Separated by commas, subdomains included."),
    totpSecret: field(
      "totpSecret",
      "Two-factor secret",
      totpInput,
      existing?.totp ? "Enter it again, otherwise two-factor sign-in is missing afterwards." : "The key behind the QR code, Base32. Optional.",
    ),
  } satisfies Record<FieldName, ReturnType<typeof field>>;

  // Name and hosts follow the address until the owner changes them.
  let siteTouched = existing !== null;
  let hostsTouched = existing !== null;
  siteInput.addEventListener("input", () => (siteTouched = true));
  hostsInput.addEventListener("input", () => (hostsTouched = true));
  const hostList = () =>
    (hostsInput.value.trim() || hostOf(urlInput.value))
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  const syncFromUrl = () => {
    const host = hostOf(urlInput.value);
    if (!hostsTouched) hostsInput.value = host;
    if (!siteTouched) siteInput.value = nameFrom(host);
    const hosts = hostList();
    hostHint.textContent = hosts.length > 0 ? `Serain types the password only on ${hosts.join(", ")}.` : "The page where you sign in.";
  };
  urlInput.addEventListener("input", syncFromUrl);
  hostsInput.addEventListener("input", syncFromUrl);
  syncFromUrl();

  const more = h(
    "details",
    { class: "more-fields", open: existing?.totp ? true : undefined },
    h("summary", {}, icon("chevron", "icon chevron"), "Hosts and two-factor"),
    fields.hosts.wrap,
    fields.totpSecret.wrap,
  );

  const formError = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { type: "submit", class: "btn primary" }, existing ? "Replace" : "Seal and save");
  const cancel = button("Cancel");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    fields.loginUrl.wrap,
    // When replacing, the name stays; it is already in the title.
    existing ? fields.username.wrap : h("div", { class: "row2" }, fields.site.wrap, fields.username.wrap),
    fields.password.wrap,
    more,
    h("p", { class: "seal-note" }, icon("lock"), h("span", {}, "Sealed in this browser. Only Serain's server can open it. ", h("span", { class: "mono", title: "ID of the server key" }, vault.keyId))),
    h("div", { class: "dialog-foot" }, formError, cancel, save),
  );

  const { close } = dialog(existing ? `Replace ${existing.site}` : "New login", [form]);
  cancel.addEventListener("click", close);

  let attempted = false;
  const validate = () => {
    const totp = normalizeTotpSecret(totpInput.value);
    const parsed = vaultEntrySchema.safeParse({
      site: siteInput.value.trim(),
      hosts: hostList(),
      loginUrl: urlInput.value.trim(),
      username: userInput.value,
      password: passInput.value,
      ...(totp ? { totpSecret: totp } : {}),
    });
    const errors = new Map<FieldName, string>();
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? "") as FieldName;
      if (name in fields && !errors.has(name)) errors.set(name, issue.message);
    }
    for (const [name, f] of Object.entries(fields) as Array<[FieldName, (typeof fields)[FieldName]]>) f.setError(errors.get(name) ?? "");
    if (errors.has("hosts") || errors.has("totpSecret")) more.open = true;
    return { parsed, errors };
  };
  // After the first attempt, errors disappear as soon as they are fixed instead of staying until the next click.
  form.addEventListener("input", () => attempted && validate());

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    attempted = true;
    formError.replaceChildren();
    const { parsed, errors } = validate();
    if (!parsed.success) {
      const first = (["loginUrl", "site", "username", "password", "hosts", "totpSecret"] as const).find((name) => errors.has(name));
      if (first) fields[first].input.focus();
      return;
    }
    const entry = parsed.data;
    void busy(save, "Sealing …", async () => {
      const sealed = await sealTo(vault.publicKey, entry.site, entry);
      await withReauth(() =>
        api(`/api/vault/${entry.site}`, {
          method: "PUT",
          body: { username: entry.username, hosts: entry.hosts, loginUrl: entry.loginUrl, totp: entry.totpSecret !== undefined, sealed },
        }),
      );
    })
      .then(() => {
        passInput.value = "";
        totpInput.value = "";
        close();
        done(entry.site);
      })
      // What was typed stays; only the message is added.
      .catch((error: unknown) => formError.replaceChildren(icon("alert"), message(error)));
  });

  (existing ? passInput : urlInput).focus();
}

/* ---------- Files ---------- */

/** What a browser can read as an image and write again without metadata. HEIC only in Safari; if it fails, the dialog says so. */
const REENCODE = /^image\/(jpeg|png|webp|heic|heif|avif)$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|avif)$/i;
/** The browser does not even read anything larger; a photo usually gets smaller when written again. */
const RAW_MAX_BYTES = 40 * 1024 * 1024;
/** Longest side after writing again. Safari does not draw larger canvases, and it is plenty for a copy of an ID. */
const IMAGE_MAX_SIDE = 4096;

/** Something about the file itself; the message then shows at the field, not at the bottom of the dialog. */
class FileProblem extends Error {}

/** The name the owner uses for the file when talking to Serain: "passport" for "Passport 2026.pdf". Umlauts are spelled out the German way, other accents dropped. */
function nameFromFile(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const slug = stem
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 31)
    .replace(/-+$/, "");
  return VAULT_FILE_NAME.test(slug) ? slug : "";
}

function mimeOf(file: File, bytes: Uint8Array): string {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  const declared = file.type.trim().toLowerCase();
  if (MIME_TYPE.test(declared)) return declared;
  if (/\.heic$/i.test(file.name)) return "image/heic";
  if (/\.heif$/i.test(file.name)) return "image/heif";
  return "application/octet-stream";
}

/**
 * Photos carry metadata: the place where they were taken (often the home),
 * the device, the time. A copy of an ID that Serain later mails to someone
 * should not send that along. So the browser draws the image again (correctly
 * rotated) and keeps only the pixels; PNG stays PNG, everything else becomes
 * JPEG.
 */
async function withoutMetadata(file: File, mimeType: string): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new FileProblem("The browser cannot read this image. Export it as JPEG or PDF and try again.");
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new FileProblem("The browser cannot redraw the image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = mimeType === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!blob) throw new FileProblem("The browser cannot save the image again.");
  const ext = type === "image/png" ? ".png" : ".jpg";
  const filename = IMAGE_EXT.test(file.name) ? file.name.replace(IMAGE_EXT, ext) : `${file.name}${ext}`;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: type, filename };
}

/** Reads the file, strips images of their metadata and checks the size. Throws with a message for the field. */
async function prepareFile(file: File): Promise<{ bytes: Uint8Array; mimeType: string; filename: string; reencoded: boolean }> {
  if (file.size === 0) throw new FileProblem("The file is empty.");
  if (file.size > RAW_MAX_BYTES) throw new FileProblem(`At most ${formatSize(VAULT_FILE_MAX_BYTES)} per file.`);
  const raw = new Uint8Array(await file.arrayBuffer());
  const declared = mimeOf(file, raw);
  const image = REENCODE.test(declared) ? await withoutMetadata(file, declared) : null;
  const bytes = image?.bytes ?? raw;
  const mimeType = image?.mimeType ?? declared;
  if (bytes.length > VAULT_FILE_MAX_BYTES) throw new FileProblem(`${formatSize(bytes.length)} is too large, at most ${formatSize(VAULT_FILE_MAX_BYTES)} per file.`);
  return { bytes, mimeType, filename: cleanFileName(image?.filename ?? file.name, mimeType), reencoded: image !== null };
}

function openFileForm(vault: Vault, existing: FileRow | null, done: (name: string) => void): void {
  const fileInput = h("input", { type: "file", id: "f-file", name: "file", class: "file-input" });
  const picked = h("span", { class: "file-picked" }, existing ? `Current: ${existing.filename}, ${formatSize(existing.size)}` : "Choose a file or drop it here");
  const drop = h("label", { class: "file-drop", for: "f-file" }, icon("plus"), picked);
  const fileError = h("p", { class: "field-error", id: "f-file-error" });
  fileInput.setAttribute("aria-describedby", "f-file-error");
  const nameInput = textInput({ placeholder: "passport", value: existing?.name ?? "", maxlength: "31" });
  if (existing) nameInput.readOnly = true;
  const nameField = field("site", "Name", nameInput, "What you call it in the chat: \"send me my passport\".");

  let nameTouched = existing !== null;
  nameInput.addEventListener("input", () => (nameTouched = true));
  const chosen = () => fileInput.files?.[0] ?? null;
  const showChoice = () => {
    const file = chosen();
    fileError.replaceChildren();
    fileInput.removeAttribute("aria-invalid");
    if (!file) return;
    picked.replaceChildren(h("span", { class: "file-picked-name" }, file.name), h("span", { class: "file-picked-size" }, formatSize(file.size)));
    if (!nameTouched) nameInput.value = nameFromFile(file.name);
  };
  fileInput.addEventListener("change", showChoice);
  // Drag and drop onto the area; the file lands in the same field as when choosing.
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showChoice();
  });

  const formError = h("p", { class: "form-error", role: "alert" });
  const save = h("button", { type: "submit", class: "btn primary" }, existing ? "Replace" : "Seal and store");
  const cancel = button("Cancel");
  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "f-file" }, "File"), fileInput, drop, h("p", { class: "field-hint" }, `PDF or image, at most ${formatSize(VAULT_FILE_MAX_BYTES)}. Photos are saved again without metadata (place, device).`), fileError),
    existing ? null : nameField.wrap,
    h(
      "p",
      { class: "seal-note" },
      icon("lock"),
      h("span", {}, "Sealed in this browser. Only Serain's server can open it; Serain itself sees only name and size. You cannot view it here anymore, but Serain sends it to you over iMessage. ", h("span", { class: "mono", title: "ID of the server key" }, vault.keyId)),
    ),
    h("div", { class: "dialog-foot" }, formError, cancel, save),
  );

  const { close } = dialog(existing ? `Replace ${existing.name}` : "New file", [form]);
  cancel.addEventListener("click", close);

  const setFileError = (text: string) => {
    fileInput.setAttribute("aria-invalid", "true");
    fileError.replaceChildren(icon("alert"), text);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    formError.replaceChildren();
    const file = chosen();
    const name = nameInput.value.trim();
    nameField.setError(VAULT_FILE_NAME.test(name) ? "" : "Name of lowercase letters, digits, - and _, 2 to 31 characters");
    if (!file) setFileError("No file chosen.");
    if (!file) return fileInput.focus();
    if (!VAULT_FILE_NAME.test(name)) return nameInput.focus();
    if (!existing && vault.files.some((other) => other.name === name)) {
      nameField.setError(`"${name}" already exists. Use another name, or replace it there.`);
      return nameInput.focus();
    }
    void busy(save, "Sealing …", async () => {
      const prepared = await prepareFile(file);
      const header = { name, filename: prepared.filename, mimeType: prepared.mimeType, size: prepared.bytes.length, sha256: await sha256Hex(prepared.bytes) };
      const sealed = bytesToBase64Url(await sealBytesTo(vault.publicKey, name, packVaultFile(header, prepared.bytes)));
      prepared.bytes.fill(0);
      await withReauth(() =>
        api(`/api/vault/files/${name}`, { method: "PUT", body: { filename: header.filename, mimeType: header.mimeType, size: header.size, sealed } }),
      );
    })
      .then(() => {
        fileInput.value = "";
        close();
        done(name);
      })
      .catch((error: unknown) => {
        if (error instanceof FileProblem) setFileError(error.message);
        else formError.replaceChildren(icon("alert"), message(error));
      });
  });

  fileInput.focus();
}

function filesView(vault: Vault, saved: (name: string) => void, redraw: (vault: Vault) => void, refresh: () => Promise<void>): HTMLElement {
  if (vault.files.length === 0) {
    const first = button("Store the first file", { variant: "primary" });
    first.addEventListener("click", () => openFileForm(vault, null, saved));
    return empty(
      "No files yet.",
      "Documents you will need at some point, say a copy of your ID. Serain sends them to you when you ask or attaches them to a mail you see first. It never sees the content.",
      first,
    );
  }
  return h(
    "ul",
    { class: "vault-list" },
    h("li", { class: "vault-head", "aria-hidden": "true" }, h("span", {}, "Name"), h("span", {}, "File"), h("span", {}, "Size"), h("span", {}, "Changed"), h("span", {})),
    ...vault.files.map((file) => {
      const replace = button("Replace", { variant: "quiet", class: "small" });
      replace.addEventListener("click", () => openFileForm(vault, file, saved));
      const remove = button("Delete", { variant: "quiet", class: "small" });
      remove.addEventListener("click", () =>
        confirmDialog({
          title: `Delete ${file.name}?`,
          text: "Serain can then no longer send it to you. There is no undo, only storing it again.",
          confirm: `Delete ${file.name}`,
          run: async () => {
            await withReauth(() => api(`/api/vault/files/${file.name}`, { method: "DELETE" }));
            toast(`${file.name} is deleted.`);
            redraw({ ...vault, files: vault.files.filter((other) => other.name !== file.name) });
            void refresh().catch(() => undefined);
          },
        }),
      );
      return h(
        "li",
        { class: "vault-item" },
        h("p", { class: "vault-name" }, file.name),
        h("p", { class: "vault-file" }, file.filename),
        h("p", { class: "vault-size" }, formatSize(file.size)),
        h("time", { class: "vault-date", datetime: file.updated_at, title: "Last changed" }, compactDate(new Date(file.updated_at))),
        h("div", { class: "vault-actions" }, replace, remove),
      );
    }),
  );
}

/* ---------- Logins ---------- */

function entriesView(vault: Vault, saved: (site: string) => void, redraw: (vault: Vault) => void, refresh: () => Promise<void>): HTMLElement {
  if (vault.entries.length === 0) {
    const first = button("Add the first login", { variant: "primary" });
    first.addEventListener("click", () => openForm(vault, null, saved));
    return empty("No logins yet.", "Only accounts where you are fine with Serain signing in. You confirm every sign-in beforehand over iMessage.", first);
  }
  return h(
    "ul",
    { class: "vault-list" },
    // Column heads, only visible when the list is wide enough for a table.
    h("li", { class: "vault-head", "aria-hidden": "true" }, h("span", {}, "Name"), h("span", {}, "User"), h("span", {}, "Hosts"), h("span", {}, "Changed"), h("span", {})),
    ...vault.entries.map((entry) => {
      const replace = button("Replace", { variant: "quiet", class: "small" });
      replace.addEventListener("click", () => openForm(vault, entry, saved));
      const remove = button("Delete", { variant: "quiet", class: "small" });
      remove.addEventListener("click", () =>
        confirmDialog({
          title: `Delete ${entry.site}?`,
          text: "Serain can then no longer sign in there for you. There is no undo, only adding it again.",
          confirm: `Delete ${entry.site}`,
          run: async () => {
            await withReauth(() => api(`/api/vault/${entry.site}`, { method: "DELETE" }));
            toast(`${entry.site} is deleted.`);
            redraw({ ...vault, entries: vault.entries.filter((other) => other.site !== entry.site) });
            void refresh().catch(() => undefined);
          },
        }),
      );
      return h(
        "li",
        { class: "vault-item" },
        // The space separates the tag from the name and disappears when the tag wraps to the next line.
        h("p", { class: "vault-name" }, entry.site, entry.totp ? " " : null, entry.totp ? h("span", { class: "chip", title: "With two-factor secret" }, "2FA") : null),
        h("p", { class: "vault-user" }, entry.username),
        h("p", { class: "vault-hosts" }, entry.hosts.join(", ")),
        h("time", { class: "vault-date", datetime: entry.updated_at, title: "Last changed" }, compactDate(new Date(entry.updated_at))),
        h("div", { class: "vault-actions" }, replace, remove),
      );
    }),
  );
}

export const vaultPage: Page = {
  title: "Vault",
  render(main, signal) {
    const slug = location.pathname.split("/")[2] ?? "";
    const view = VIEWS.find((v) => v.slug === slug) ?? VIEWS[0];
    const head = h("header", { class: "page-head" }, h("h1", {}, "Vault"));
    const tabs = h("nav", { class: "tabs", "aria-label": "Vault" });
    const body = h("div", { class: "tab-body" });
    main.replaceChildren(h("div", { class: "page" }, head, tabs, body));

    const drawTabs = (counts: Record<string, number>) =>
      tabs.replaceChildren(
        ...VIEWS.map((v) =>
          h(
            "a",
            { href: v.slug ? `/vault/${v.slug}` : "/vault", class: "tab", "aria-current": v === view ? "page" : undefined, "data-nav": "replace" },
            v.label,
            counts[v.slug] !== undefined ? h("span", { class: "count" }, String(counts[v.slug])) : null,
          ),
        ),
      );
    drawTabs({});

    const refresh = async () => {
      forget(PATH);
      const fresh = await load<Vault>(PATH);
      if (!signal.aborted) draw(fresh);
    };
    const saved = (text: string) => {
      toast(text);
      void refresh().catch((error: unknown) => toast(message(error)));
    };

    const draw = (vault: Vault) => {
      drawTabs({ "": vault.entries.length, files: vault.files.length });
      const files = view.slug === "files";
      const list = files ? vault.files : vault.entries;
      const add = button([icon("plus"), files ? "Store file" : "New login"], { variant: "primary", class: "small" });
      add.addEventListener("click", () => (files ? openFileForm(vault, null, (name) => saved(`${name} is in the vault.`)) : openForm(vault, null, (site) => saved(`${site} is in the vault.`))));
      head.replaceChildren(h("h1", {}, "Vault"), list.length > 0 ? add : "");
      body.replaceChildren(
        files
          ? filesView(vault, (name) => saved(`${name} is in the vault.`), draw, refresh)
          : entriesView(vault, (site) => saved(`${site} is in the vault.`), draw, refresh),
      );
    };

    const known = cached<Vault>(PATH);
    if (known) draw(known);
    else body.replaceChildren(skeleton(3));
    if (known && isFresh(PATH)) return;
    return load<Vault>(PATH).then((data) => {
      if (!signal.aborted) draw(data);
    });
  },
};
