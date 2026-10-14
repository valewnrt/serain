import { readFileSync } from "node:fs";
import { join } from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";
import { SITE_ORIGIN, type Lang } from "./content/site.js";
import { T } from "./content/text.js";

/**
 * The social preview of serain.si (D65), one per language, drawn at build
 * time: the dusk photograph, the logo in its serif and the hero's lines in
 * the sans, so a shared link says what Serain is. The text is set as paths
 * (opentype.js) and the result rasterised by sharp, so no system font decides
 * how it looks.
 */

const W = 1200;
const H = 630;
const MARGIN = 72;

type Font = opentype.Font;

function load(file: string): Font {
  const buffer = readFileSync(file);
  return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
}

/**
 * One centred line as a path. Glyphs are placed one by one with the font's
 * kerning (opentype.js cannot shape these fonts' ccmp lookups, and Latin text
 * needs no shaping); a line too wide for the image is set smaller.
 */
function line(font: Font, text: string, size: number, baseline: number, tracking: number, opacity: number): string {
  const glyphs = [...text].map((char) => {
    const glyph = font.charToGlyph(char);
    if (glyph.index === 0 && char !== " ") throw new Error(`site/og.ts: ${font.names.fullName?.en ?? "font"} has no glyph for "${char}".`);
    return glyph;
  });
  const layout = (px: number) => {
    const scale = px / font.unitsPerEm;
    const xs: number[] = [];
    let x = 0;
    glyphs.forEach((glyph, index) => {
      xs.push(x);
      const next = glyphs[index + 1];
      x += (glyph.advanceWidth ?? 0) * scale + (next ? font.getKerningValue(glyph, next) * scale + tracking * px : 0);
    });
    return { xs, width: x };
  };
  let px = size;
  let { xs, width } = layout(px);
  while (width > W - 2 * MARGIN) ({ xs, width } = layout((px -= 1)));
  const left = (W - width) / 2;
  const d = glyphs.map((glyph, index) => glyph.getPath(left + xs[index]!, baseline, px).toPathData(2)).join("");
  return `<path d="${d}" fill="#fff" fill-opacity="${opacity}"/>`;
}

export interface OgFonts {
  serif: string;
  sans: string;
  sansMedium: string;
}

/** The fonts the build already has: the logo's serif and Inter for the lines. */
export function ogFonts(nodeModules: string): OgFonts {
  return {
    serif: join(nodeModules, "@fontsource", "instrument-serif", "files", "instrument-serif-latin-400-normal.woff"),
    sans: join(nodeModules, "@fontsource", "inter", "files", "inter-latin-600-normal.woff"),
    sansMedium: join(nodeModules, "@fontsource", "inter", "files", "inter-latin-500-normal.woff"),
  };
}

/** The preview for a language as JPEG, 1200 × 630. */
export async function renderOg(lang: Lang, photo: Buffer, files: OgFonts): Promise<Buffer> {
  const serif = load(files.serif);
  const sans = load(files.sans);
  const medium = load(files.sansMedium);
  const background = await sharp(photo).resize(W, H, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.34"/>
      <stop offset="0.62" stop-color="#000" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.3"/>
    </linearGradient>
  </defs>
  <image width="${W}" height="${H}" xlink:href="data:image/jpeg;base64,${background.toString("base64")}"/>
  <rect width="${W}" height="${H}" fill="url(#shade)"/>
  ${line(serif, "Serain", 136, 238, 0, 1)}
  ${line(sans, T.headline[lang], 54, 338, -0.03, 1)}
  ${line(sans, T.headline2[lang], 54, 404, -0.03, 0.72)}
  ${line(medium, T.sub[lang], 26, 466, -0.01, 0.82)}
  ${line(medium, new URL(SITE_ORIGIN).hostname, 22, 588, 0, 0.72)}
</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
}
