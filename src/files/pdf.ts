/**
 * Text as PDF (sending files, audit 2026-10-05): a summary, a list, a letter the
 * owner wants to forward or print. Deliberately small and without a library:
 * a heading plus paragraphs in Helvetica, A4, line breaks by the character
 * widths of the font. This only writes, it never reads a foreign PDF; so it
 * runs in the process and not in the sandbox (D20 is about parsers that get
 * files from the web).
 *
 * The standard fonts only know WinAnsi (Latin-1 plus € and typographic
 * characters). What is missing there, emoji for instance, becomes "?";
 * umlauts, ß and € work. Scripts outside Latin-1 (Cyrillic, Greek, Turkish ğ,
 * ş, ı) become "?" too; such a PDF needs an embedded font, which this
 * deliberately small writer does not have.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const BODY_SIZE = 11;
const BODY_LEADING = 15;
const TITLE_SIZE = 16;
const TITLE_LEADING = 21;

/** Characters from 0x80 to 0x9F in WinAnsi, by Unicode. */
const WIN_ANSI_HIGH: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b,
  "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99,
  "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Helvetica widths (AFM, thousandths of the font size) for 32 to 126. */
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Helvetica widths for 0x80 to 0xFF; 0 means unassigned. */
const HIGH_WIDTHS = [
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000,
  500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333,
  333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278,
  278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500,
  556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** A character as a WinAnsi byte; what does not exist there becomes "?". */
export function winAnsi(char: string): number {
  const code = char.codePointAt(0) ?? 63;
  if (code >= 32 && code <= 126) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI_HIGH[char] ?? 63;
}

function width(byte: number, size: number): number {
  const units = byte >= 32 && byte <= 126 ? ASCII_WIDTHS[byte - 32]! : byte >= 0x80 ? HIGH_WIDTHS[byte - 0x80] || 556 : 556;
  return (units * size) / 1000;
}

/** Text as WinAnsi bytes, tabs as spaces, control characters removed. */
function encode(text: string): number[] {
  return [...text.replace(/\t/g, "    ").replace(/[\u0000-\u001f\u007f]/g, "")].map(winAnsi);
}

/** Breaks a line at spaces, a word that is too long hard. Bold is about 8 % wider. */
export function wrap(bytes: readonly number[], size: number, maxWidth: number, bold = false): number[][] {
  const factor = bold ? 1.08 : 1;
  const lines: number[][] = [];
  let line: number[] = [];
  let lineWidth = 0;
  const words: number[][] = [];
  let word: number[] = [];
  for (const byte of bytes) {
    if (byte === 32) {
      words.push(word);
      word = [];
    } else word.push(byte);
  }
  words.push(word);
  for (const current of words) {
    const wordWidth = current.reduce((sum, byte) => sum + width(byte, size) * factor, 0);
    const space = line.length > 0 ? width(32, size) * factor : 0;
    if (line.length > 0 && lineWidth + space + wordWidth > maxWidth) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    if (line.length > 0) {
      line.push(32);
      lineWidth += width(32, size) * factor;
    }
    for (const byte of current) {
      const w = width(byte, size) * factor;
      if (lineWidth + w > maxWidth && line.length > 0) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      line.push(byte);
      lineWidth += w;
    }
  }
  lines.push(line);
  return lines;
}

/** A PDF string in parentheses: backslash and parentheses escaped, bytes as Latin-1. */
function pdfString(bytes: readonly number[]): string {
  let out = "(";
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

interface Line {
  bytes: number[];
  font: "F1" | "F2";
  size: number;
  /** Distance to the previous line. */
  advance: number;
}

/** Builds the PDF. Does not throw: every input yields a readable document. */
export function buildPdf(input: { title?: string | undefined; text: string; maxPages: number }): { body: Buffer; pages: number; truncated: boolean } {
  const usable = PAGE_WIDTH - 2 * MARGIN;
  const lines: Line[] = [];
  if (input.title) {
    for (const bytes of wrap(encode(input.title), TITLE_SIZE, usable, true)) lines.push({ bytes, font: "F2", size: TITLE_SIZE, advance: TITLE_LEADING });
    lines.push({ bytes: [], font: "F1", size: BODY_SIZE, advance: BODY_LEADING / 2 });
  }
  for (const paragraph of input.text.replace(/\r\n?/g, "\n").split("\n")) {
    for (const bytes of wrap(encode(paragraph), BODY_SIZE, usable)) lines.push({ bytes, font: "F1", size: BODY_SIZE, advance: BODY_LEADING });
  }

  const pages: Line[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    if (y - line.advance < MARGIN) {
      pages.push([]);
      y = PAGE_HEIGHT - MARGIN;
    }
    y -= line.advance;
    pages[pages.length - 1]!.push(line);
  }
  const truncated = pages.length > input.maxPages;
  const kept = pages.slice(0, input.maxPages);

  const streams = kept.map((page) => {
    let top = PAGE_HEIGHT - MARGIN;
    const ops = page.flatMap((line) => {
      top -= line.advance;
      return line.bytes.length === 0 ? [] : [`BT /${line.font} ${line.size} Tf 1 0 0 1 ${MARGIN} ${top.toFixed(2)} Tm ${pdfString(line.bytes)} Tj ET`];
    });
    return ops.join("\n");
  });

  // Objects: 1 catalog, 2 page tree, 3 and 4 fonts, then per page the page and its content.
  const objects: string[] = [];
  const pageIds = kept.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${kept.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  streams.forEach((stream, index) => {
    const pageId = pageIds[index]!;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { body: Buffer.from(out, "latin1"), pages: kept.length, truncated };
}
