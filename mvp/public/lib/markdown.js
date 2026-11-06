/**
 * A small, safe Markdown renderer for assistant replies on the chat page.
 *
 * Model output is untrusted. This module never uses innerHTML: `parseMarkdown` turns text into a plain tree
 * and `renderMarkdown` builds DOM nodes from it with createElement and textContent only, so no model text can
 * become markup or script. Rules that keep it safe:
 * - links render only for http: and https: URLs, as plain text otherwise, with rel="noopener noreferrer nofollow";
 * - images are never rendered (a remote image would let the model send data to a third party in its URL), so
 *   `![alt](url)` shows as text;
 * - raw HTML in the text is shown literally.
 *
 * Supported: fenced code, headings, horizontal rules, block quotes, bullet and numbered lists (nested by
 * indent), tables, paragraphs with line breaks, and inline code, bold, italic and links. Anything else
 * stays plain text. No dependencies.
 */

const MAX_DEPTH = 6;
const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

/** Returns the URL when it is a plain http(s) URL, else undefined. */
export function safeHref(url) {
  return typeof url === "string" && SAFE_URL.test(url.trim()) ? url.trim() : undefined;
}

const isAlnum = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** Parses inline Markdown into nodes: { t: "text" | "code" | "strong" | "em" | "link" | "br", ... }. */
export function parseInline(source, depth = 0) {
  const nodes = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ t: "text", v: buffer });
    buffer = "";
  };
  const s = String(source);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()#+\-.!|>~]/.test(s[i + 1])) {
      buffer += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (s[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = s.indexOf(fence, i + run);
      if (close > i + run) {
        flush();
        nodes.push({ t: "code", v: s.slice(i + run, close).replace(/^ (.*) $/, "$1") });
        i = close + run;
        continue;
      }
      buffer += fence;
      i += run;
      continue;
    }
    if (depth < MAX_DEPTH && (s.startsWith("**", i) || s.startsWith("__", i))) {
      const mark = s.slice(i, i + 2);
      const close = s.indexOf(mark, i + 2);
      if (close > i + 2 && !/^\s/.test(s[i + 2]) && (mark === "**" || !isAlnum(s[i - 1]))) {
        flush();
        nodes.push({ t: "strong", c: parseInline(s.slice(i + 2, close), depth + 1) });
        i = close + 2;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (ch === "*" || ch === "_") && s[i + 1] !== ch && s[i + 1] !== undefined && !/\s/.test(s[i + 1])) {
      if (ch === "*" || !isAlnum(s[i - 1])) {
        let close = s.indexOf(ch, i + 1);
        while (close !== -1 && (/\s/.test(s[close - 1]) || (ch === "_" && isAlnum(s[close + 1])))) close = s.indexOf(ch, close + 1);
        if (close > i + 1) {
          flush();
          nodes.push({ t: "em", c: parseInline(s.slice(i + 1, close), depth + 1) });
          i = close + 1;
          continue;
        }
      }
    }
    if (ch === "[" && depth < MAX_DEPTH && s[i - 1] !== "!") {
      const labelEnd = s.indexOf("](", i + 1);
      const urlEnd = labelEnd === -1 ? -1 : s.indexOf(")", labelEnd + 2);
      if (labelEnd > i && urlEnd > labelEnd + 2) {
        const href = safeHref(s.slice(labelEnd + 2, urlEnd));
        if (href) {
          flush();
          nodes.push({ t: "link", href, c: parseInline(s.slice(i + 1, labelEnd), depth + 1) });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return nodes;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

const isTableStart = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("|");

/** Builds list items from consecutive list lines, nesting by indent. */
function parseList(lines, start, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length < baseIndent) break;
    if (m[1].length > baseIndent) {
      if (depth >= MAX_DEPTH || items.length === 0) break;
      const nested = parseList(lines, i, depth + 1);
      items[items.length - 1].children.push(nested.block);
      i = nested.next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    items.push({ c: parseInline(m[3]), children: [] });
    i += 1;
  }
  return { block: { t: "list", ordered, items }, next: i };
}

/** Parses Markdown text into blocks. Never throws; unterminated constructs (as in a streaming reply) are closed at the end. */
export function parseMarkdown(source, depth = 0) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ t: "p", lines: paragraph.map((line) => parseInline(line.trim())) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      endParagraph();
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[1]) && /^\s*[`~]+\s*$/.test(lines[i]))) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ t: "code", lang: fence[2] || undefined, v: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      endParagraph();
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ t: "h", level: heading[1].length, c: parseInline(heading[2]) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      endParagraph();
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      endParagraph();
      const head = splitRow(line).map((cell) => parseInline(cell));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        const cells = splitRow(lines[i]).map((cell) => parseInline(cell));
        while (cells.length < head.length) cells.push([]);
        rows.push(cells.slice(0, head.length));
        i += 1;
      }
      blocks.push({ t: "table", head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      endParagraph();
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ t: "quote", c: depth < MAX_DEPTH ? parseMarkdown(quoted.join("\n"), depth + 1) : [{ t: "p", lines: [[{ t: "text", v: quoted.join(" ") }]] }] });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      endParagraph();
      const list = parseList(lines, i, 0);
      blocks.push(list.block);
      i = list.next;
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  endParagraph();
  return blocks;
}

function renderInline(doc, nodes, parent) {
  for (const node of nodes) {
    if (node.t === "text") {
      parent.append(doc.createTextNode(node.v));
    } else if (node.t === "code") {
      const code = doc.createElement("code");
      code.textContent = node.v;
      parent.append(code);
    } else if (node.t === "strong" || node.t === "em") {
      const tag = doc.createElement(node.t);
      renderInline(doc, node.c, tag);
      parent.append(tag);
    } else if (node.t === "link") {
      const a = doc.createElement("a");
      a.setAttribute("href", node.href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
      renderInline(doc, node.c, a);
      parent.append(a);
    }
  }
}

function renderBlocks(doc, blocks, parent) {
  for (const block of blocks) {
    if (block.t === "p") {
      const p = doc.createElement("p");
      block.lines.forEach((line, index) => {
        if (index > 0) p.append(doc.createElement("br"));
        renderInline(doc, line, p);
      });
      parent.append(p);
    } else if (block.t === "h") {
      const h = doc.createElement(`h${Math.min(6, block.level + 2)}`);
      renderInline(doc, block.c, h);
      parent.append(h);
    } else if (block.t === "hr") {
      parent.append(doc.createElement("hr"));
    } else if (block.t === "code") {
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      code.textContent = block.v;
      pre.append(code);
      parent.append(pre);
    } else if (block.t === "quote") {
      const quote = doc.createElement("blockquote");
      renderBlocks(doc, block.c, quote);
      parent.append(quote);
    } else if (block.t === "list") {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        renderInline(doc, item.c, li);
        renderBlocks(doc, item.children, li);
        list.append(li);
      }
      parent.append(list);
    } else if (block.t === "table") {
      const wrap = doc.createElement("div");
      wrap.className = "md-table";
      const table = doc.createElement("table");
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of block.head) {
        const th = doc.createElement("th");
        renderInline(doc, cell, th);
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        for (const cell of row) {
          const td = doc.createElement("td");
          renderInline(doc, cell, td);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      parent.append(wrap);
    }
  }
}

/** Renders Markdown text into a DocumentFragment built from DOM nodes only. `doc` is the page's document. */
export function renderMarkdown(doc, source) {
  const fragment = doc.createDocumentFragment();
  renderBlocks(doc, parseMarkdown(source), fragment);
  return fragment;
}
