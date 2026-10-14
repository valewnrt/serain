import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { renderSite } from "./content/render.js";
import { LANGS, type Lang } from "./content/site.js";
import { ogFonts, renderOg } from "./og.js";

/**
 * Builds serain.si into `site/dist` (D65): static HTML in English and German,
 * one script, one stylesheet with the web interface's tokens, the logo's
 * serif and the photographs.
 * Files under `assets/` carry the hash of their content and stay cached for a
 * year (site/worker/worker.ts).
 */
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const assets = join(dist, "assets");
const nodeModules = join(here, "..", "node_modules");
const fonts = join(nodeModules, "@fontsource", "instrument-serif", "files");
const images = join(here, "images");

rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

function emit(name: string, ext: string, content: Buffer | string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.${ext}`;
  writeFileSync(join(assets, file), content);
  return `/assets/${file}`;
}

const image = (file: string) => emit(file.replace(/\.[a-z]+$/, ""), file.split(".").pop()!, readFileSync(join(images, file)));

const script = await build({
  entryPoints: [join(here, "client", "main.ts")],
  write: false,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

const font = emit("instrument-serif-400", "woff2", readFileSync(join(fonts, "instrument-serif-latin-400-normal.woff2")));
// The web interface's tokens (colors, radii, shadows, motion), taken from its stylesheet so the two never drift.
const tokens = /^:root \{[\s\S]*?^\}/m.exec(readFileSync(join(here, "..", "web", "client", "styles.css"), "utf8"))?.[0];
if (!tokens) throw new Error("web/client/styles.css has no :root block.");
const styles = readFileSync(join(here, "styles.css"), "utf8");
if (!styles.includes("/* __WEB_TOKENS__ */")) throw new Error("site/styles.css lost its token marker.");
const css = emit("site", "css", styles.replace("/* __WEB_TOKENS__ */", tokens).replaceAll("__FONT__", font));
const js = emit("site", "js", Buffer.from(script.outputFiles[0]!.contents));

// The services' own logos (site/images/logos/README.md), by file name.
const logoDir = join(images, "logos");
const logos = new Map(
  readdirSync(logoDir)
    .filter((file) => /\.(svg|png)$/.test(file))
    .map((file) => [file, emit(`logo-${file.replace(/\.[a-z]+$/, "")}`, file.split(".").pop()!, readFileSync(join(logoDir, file)))]),
);

// What the pages are made of; the newest commit among them is the day the content last changed (sitemap lastmod, dateModified).
const CONTENT = ["site/content", "site/images", "src/connectors/catalog.ts"];
const updated = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...CONTENT], { cwd: join(here, ".."), encoding: "utf8" }).trim();
if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`git has no commit for ${CONTENT.join(", ")}.`);

const photo = readFileSync(join(images, "og.jpg"));
const og = Object.fromEntries(await Promise.all(LANGS.map(async (lang) => [lang, emit(`og-${lang}`, "jpg", await renderOg(lang, photo, ogFonts(nodeModules)))] as const))) as Record<Lang, string>;

const files = renderSite({
  css,
  js,
  font,
  dusk: image("dusk.webp"),
  dusk960: image("dusk-960.webp"),
  night: image("night.webp"),
  night960: image("night-960.webp"),
  og,
  updated,
  logo(file) {
    const path = logos.get(file);
    if (!path) throw new Error(`site/images/logos has no ${file}.`);
    return path;
  },
});
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  writeFileSync(join(dist, path), content);
}
copyFileSync(join(here, "..", "web", "client", "favicon.svg"), join(dist, "favicon.svg"));
console.log(`site/dist built (${Object.keys(files).length} pages and files, site.js ${(script.outputFiles[0]!.contents.length / 1024).toFixed(1)} KB)`);
