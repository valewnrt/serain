import { h } from "./dom.js";

/**
 * The little bit of Markdown the user model is written in: headings, lists
 * (nested too, with wrapped continuation lines), horizontal rules, paragraphs,
 * **bold**, *italic* and `code`. Built only with elements and text nodes;
 * links stay text, because the content comes from memory and not from here.
 */

export interface Heading {
  id: string;
  level: number;
  text: string;
}

const INLINE = /(\*\*(.+?)\*\*|`([^`]+)`|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|\[([^\]]+)\]\([^)\s]+\))/g;

function inline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    if (match[2] !== undefined) out.push(h("strong", {}, ...inline(match[2])));
    else if (match[3] !== undefined) out.push(h("code", {}, match[3]));
    else if (match[4] !== undefined) out.push(h("em", {}, ...inline(match[4])));
    else if (match[5] !== undefined) out.push(document.createTextNode(match[5]));
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Text without Markdown characters, for the table of contents. */
const plain = (text: string) => text.replace(/\*\*|`/g, "").trim();

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(source: string, idPrefix = "md"): { body: HTMLElement; headings: Heading[] } {
  const body = h("div", { class: "md" });
  const headings: Heading[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  let paragraph: string[] = [];
  /** Open lists from outer to inner; `indent` is the indentation of their items. */
  let lists: Array<{ el: HTMLElement; indent: number; ordered: boolean }> = [];
  /** Text of the list items; rendered only at the end, once all continuation lines are attached. */
  const items: Array<{ li: HTMLElement; text: string }> = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) body.append(h("p", {}, ...inline(paragraph.join(" "))));
    paragraph = [];
  };
  const closeLists = () => {
    lists = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1]!.length;
      const id = `${idPrefix}-${headings.length + 1}`;
      headings.push({ id, level, text: plain(heading[2]!) });
      body.append(h(`h${Math.min(level + 1, 6)}` as "h2", { id, class: `md-h${level}` }, ...inline(heading[2]!)));
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      body.append(h("hr"));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const indent = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      while (lists.length > 0 && lists[lists.length - 1]!.indent > indent) lists.pop();
      let top = lists[lists.length - 1];
      if (top && top.indent === indent && top.ordered !== ordered) {
        lists.pop();
        top = lists[lists.length - 1];
      }
      if (!top || top.indent < indent) {
        const el = h(ordered ? "ol" : "ul");
        const parentItem = top ? items[items.length - 1] : undefined;
        if (parentItem) parentItem.li.append(el);
        else body.append(el);
        top = { el, indent, ordered };
        lists.push(top);
      }
      const li = h("li");
      top.el.append(li);
      items.push({ li, text: item[3]! });
      continue;
    }

    // Indented continuation line of a list item.
    if (lists.length > 0 && /^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1]!.text += ` ${line.trim()}`;
      continue;
    }

    closeLists();
    paragraph.push(line.trim());
  }
  flushParagraph();

  for (const { li, text } of items) li.prepend(...inline(text));
  return { body, headings };
}
