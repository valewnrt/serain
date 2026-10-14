import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Builds the client into `web/dist`: one script, one stylesheet, the font for
 * the logo. No source other than this domain. Everything under `assets/` carries
 * the hash of its content in its name and may therefore stay cached forever
 * (`withCaching` in src/worker.ts); only `index.html` is revalidated every time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const assets = join(dist, "assets");
const fonts = join(here, "..", "node_modules", "@fontsource", "instrument-serif", "files");

rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

/** Writes `content` as `assets/<name>.<hash>.<ext>` and returns the path the page loads the file from. */
function emit(name: string, ext: string, content: Buffer | string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const file = `${name}.${hash}.${ext}`;
  writeFileSync(join(assets, file), content);
  return `/assets/${file}`;
}

// Logos of the services on the Connections page (D51), with the hash in the name like everything else.
// The instance brings the logos of its own services (docs/INSTANCE.md).
const logoDirs = [join(here, "client", "logos"), join(here, "..", "instance", "logos")].filter((dir) => existsSync(dir));
const logos = Object.fromEntries(
  logoDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith(".png"))
      .map((file) => [file.replace(/\.png$/, ""), emit(`logo-${file.replace(/\.png$/, "")}`, "png", readFileSync(join(dir, file)))]),
  ),
);

const result = await build({
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
  define: { __LOGOS__: JSON.stringify(logos) },
});

const font = emit("instrument-serif-400", "woff2", readFileSync(join(fonts, "instrument-serif-latin-400-normal.woff2")));
const script = emit("app", "js", Buffer.from(result.outputFiles[0]!.contents));
const css = emit("app", "css", readFileSync(join(here, "client", "styles.css"), "utf8").replaceAll("__FONT__", font));

const html = readFileSync(join(here, "client", "index.html"), "utf8").replaceAll("__FONT__", font).replaceAll("__CSS__", css).replaceAll("__JS__", script);
writeFileSync(join(dist, "index.html"), html);
copyFileSync(join(here, "client", "favicon.svg"), join(dist, "favicon.svg"));
console.log(`web/dist built (app.js ${(result.outputFiles[0]!.contents.length / 1024).toFixed(1)} KB)`);
