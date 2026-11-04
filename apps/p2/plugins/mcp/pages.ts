// The browser pages of MCP sign-ins: a result (signed in, or why not) and the page that finds out whether the browser
// runs on the p2 host before choosing where the sign-in returns. Plain HTML with their own strict CSP.

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

/** A page saying `title`, then `message`. */
export function resultPage(title: string, message: string): string {
	return document(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** Sends `html` with `status` and a CSP allowing nothing but inline styles (and `extra` directives). */
export function sendPage(response: ServerResponse, status: number, html: string, extra: readonly string[] = []): void {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
			...extra,
		].join("; "),
	});
	response.end(html);
}

/**
 * Sends the page that asks the p2 host's loopback probe at `probeUrl` whether this browser runs there, then continues
 * the sign-in to `server` with `?via=loopback` (it does) or `?via=callback` (it does not, or the browser blocks the
 * request). While the answer takes long (a browser asking the user for local network access), the page offers both.
 */
export function sendProbePage(response: ServerResponse, server: string, probeUrl: string): void {
	const nonce = randomBytes(16).toString("base64");
	const body = `<h1>Sign in to ${escapeHtml(server)}</h1>
<p id="checking">Checking whether this browser runs on the p2 computer…</p>
<div id="choose" hidden>
<p>Where does this browser run?</p>
<p><a href="?via=loopback">On the p2 computer</a></p>
<p><a href="?via=callback">On another device</a></p>
</div>
<noscript><p><a href="?via=loopback">This browser runs on the p2 computer</a></p><p><a href="?via=callback">This browser runs on another device</a></p></noscript>
<script nonce="${nonce}">
let chosen = false;
const go = (via) => { if (!chosen) { chosen = true; location.replace("?via=" + via); } };
for (const link of document.querySelectorAll("#choose a")) link.addEventListener("click", () => { chosen = true; });
const slow = setTimeout(() => { document.getElementById("checking").hidden = true; document.getElementById("choose").hidden = false; }, 1500);
fetch(${JSON.stringify(probeUrl)}, { cache: "no-store" }).then(
	(answer) => { clearTimeout(slow); go(answer.ok ? "loopback" : "callback"); },
	() => { clearTimeout(slow); go("callback"); },
);
</script>`;
	sendPage(response, 200, document(`Sign in to ${server}`, body), [
		`script-src 'nonce-${nonce}'`,
		`connect-src ${new URL(probeUrl).origin}`,
	]);
}

function document(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}a{color:#0a58ca}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}a{color:#6ea8fe}}</style>
</head><body>${body}</body></html>`;
}

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
	);
}
