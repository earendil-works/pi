/**
 * Renders assistant message markdown to a self-contained HTML document
 * with GFM table support, syntax highlighting, a dark theme, and a
 * textarea submit bar at the bottom.
 *
 * The textarea sends messages back to the host via `glimpse.send()`.
 * Keyboard: Enter = submit, Shift+Enter = newline (matching mu editor).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import hljs from "highlight.js";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** highlight.js CSS theme read once from node_modules */
let cachedThemeCss: string | null = null;

function getHljsThemeCss(): string {
	if (cachedThemeCss !== null) return cachedThemeCss;
	try {
		const cssPath = join(__dirname, "../../node_modules/highlight.js/styles/github-dark-dimmed.min.css");
		cachedThemeCss = readFileSync(cssPath, "utf-8");
	} catch {
		cachedThemeCss = "";
	}
	return cachedThemeCss;
}

const markedInstance = new Marked(
	markedHighlight({
		langPrefix: "hljs language-",
		highlight(code: string, lang: string) {
			const language = hljs.getLanguage(lang) ? lang : "plaintext";
			return hljs.highlight(code, { language }).value;
		},
	}),
);

const BASE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: #1e1e2e;
  color: #cdd6f4;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
}
#content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 100%;
}
#content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
#content th, #content td { border: 1px solid #45475a; padding: 8px 12px; text-align: left; }
#content th { background: #313244; font-weight: 600; }
#content tr:nth-child(even) { background: #181825; }
#content code { background: #313244; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
#content pre { background: #313244; padding: 12px; border-radius: 6px; overflow-x: auto; }
#content pre code { background: none; padding: 0; font-size: 0.9em; }
#content blockquote { border-left: 3px solid #45475a; margin: 0; padding-left: 16px; color: #a6adc8; }
#content h1, #content h2, #content h3, #content h4, #content h5, #content h6 { color: #cba6f7; }
#content a { color: #89b4fa; }
#content hr { border: none; border-top: 1px solid #45475a; margin: 16px 0; }
#content img { max-width: 100%; border-radius: 6px; }
#input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #45475a;
  background: #181825;
}
#input-bar textarea {
  flex: 1;
  background: #1e1e2e;
  color: #cdd6f4;
  border: 1px solid #45475a;
  border-radius: 6px;
  padding: 8px 12px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  resize: none;
  min-height: 36px;
  max-height: 120px;
  outline: none;
}
#input-bar textarea:focus { border-color: #89b4fa; }
#input-bar button {
  background: #313244;
  color: #cdd6f4;
  border: 1px solid #45475a;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 14px;
  cursor: pointer;
  white-space: nowrap;
}
#input-bar button:hover { background: #45475a; }
`;

const SUBMIT_JS = `
function initSubmit() {
  const textarea = document.getElementById('msg-input');
  const btn = document.getElementById('msg-submit');
  if (!textarea || !btn) return;

  function submit() {
    const text = textarea.value.trim();
    if (!text) return;
    if (window.glimpse && window.glimpse.send) {
      glimpse.send({ type: 'submit', text: text });
    }
    textarea.value = '';
    textarea.style.height = '36px';
  }

  textarea.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  btn.addEventListener('click', submit);

  textarea.addEventListener('input', function() {
    this.style.height = '36px';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  textarea.focus();
}
`;

/**
 * Convert markdown text to a self-contained HTML document.
 * Includes a textarea input bar that sends messages via glimpse.send().
 */
export function renderViewHtml(markdown: string): string {
	const body = markedInstance.parse(markdown) as string;
	const hljsCss = getHljsThemeCss();

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${BASE_CSS}${hljsCss}</style>
</head>
<body>
<div id="content">${body}</div>
<div id="input-bar">
  <textarea id="msg-input" rows="1" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
  <button id="msg-submit">Send</button>
</div>
<script>${SUBMIT_JS}initSubmit();</script>
</body>
</html>`;
}
