// Fetch bounded web documents, or explicitly render them in an isolated installed Chromium.
/// <reference lib="dom" />

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chromium } from "playwright-core";
import TurndownService from "turndown";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { readPdf } from "./pdf.ts";
import { MAX_READER_INPUT_BYTES, type ReaderRequest, type ReaderResult } from "./protocol.ts";

/** Fetch and extract a URL without running JavaScript unless browser was explicitly selected. */
export async function readWeb(request: ReaderRequest): Promise<ReaderResult> {
	const url = httpUrl(request.path);
	if (request.strategy === "browser") return renderBrowser(request, url);
	if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
		setGlobalDispatcher(new EnvHttpProxyAgent());
	let current = url;
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(20_000),
			headers: {
				Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/pdf;q=0.7, */*;q=0.1",
				"User-Agent": "pi-read/1.0",
			},
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location) throw new Error(`HTTP ${response.status} without a redirect location`);
			current = httpUrl(new URL(location, current).href);
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status} ${response.statusText}: ${current}`);
		}
		const contentType = response.headers.get("content-type") ?? "";
		const isPdf = contentType.toLowerCase().includes("application/pdf");
		const maximum = isPdf ? MAX_READER_INPUT_BYTES : 16 * 1024 * 1024;
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += chunk.byteLength;
			if (size > maximum) throw new Error(`HTTP document exceeds ${maximum / 1024 / 1024} MiB`);
			chunks.push(chunk);
		}
		const bytes = Buffer.concat(chunks, size);
		if (isPdf || bytes.subarray(0, 5).toString() === "%PDF-") {
			const result = await readPdf(request, bytes);
			if (result.source.kind === "pdf") result.source.finalUrl = current;
			return result;
		}
		if (request.pages || request.format === "images") throw new Error("pages and format:images require a PDF URL");
		if (contentType && !/^(text\/|application\/(?:json|xml|xhtml\+xml|[^;]+\+json))/i.test(contentType))
			throw new Error(`Unsupported HTTP content type: ${contentType}`);
		const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
		const text = new TextDecoder(charset).decode(bytes);
		if (
			/text\/(?:markdown|x-markdown|plain)|application\/(?:json|[^;]+\+json)/i.test(contentType) ||
			(!contentType && !/^\s*<(?:!doctype\s+html|html|head|body|article|main|div)\b/i.test(text))
		) {
			return {
				status: text.trim() ? "ok" : "unreadable",
				text: `URL: ${current}\nExtraction: ${contentType.includes("markdown") ? "markdown" : "plain"}\n\n${text}`,
				images: [],
				source: {
					kind: "web",
					url,
					finalUrl: current,
					strategy: contentType.includes("markdown") ? "markdown" : "plain",
					title: "",
					statusCode: response.status,
					contentType,
				},
			};
		}
		return extractHtml(
			text,
			{ kind: "web", url, finalUrl: current, strategy: "", title: "", statusCode: response.status, contentType },
			request.format === "text",
		);
	}
	throw new Error("HTTP redirect limit exceeded (5)");
}

function httpUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Web reads require an HTTP or HTTPS URL");
	if (url.username || url.password) throw new Error("Credentials in URLs are not supported");
	return url.href;
}

function extractHtml(
	html: string,
	source: Extract<ReaderResult["source"], { kind: "web" }>,
	plain: boolean,
): ReaderResult {
	const { document } = parseHTML(html);
	const login = Boolean(document.querySelector('input[type="password"]'));
	const title = document.title ?? "";
	let base = source.finalUrl;
	const declaredBase = document.querySelector("base[href]")?.getAttribute("href");
	if (declaredBase) {
		try {
			base = httpUrl(new URL(declaredBase, base).href);
		} catch {
			/* Ignore an invalid document base, not the retrieved document. */
		}
	}
	for (const element of document.querySelectorAll("a[href],img[src]")) {
		const attribute = element.tagName === "A" ? "href" : "src";
		try {
			const link = new URL(element.getAttribute(attribute) ?? "", base);
			if (!["http:", "https:", "mailto:"].includes(link.protocol)) element.removeAttribute(attribute);
			else element.setAttribute(attribute, link.href);
		} catch {
			element.removeAttribute(attribute);
		}
	}
	// Cloning a document preserves its kind; the DOM cloneNode signature only promises Node.
	const article = new Readability(document.cloneNode(true) as Document, {
		charThreshold: 100,
		maxElemsToParse: 50_000,
		disableJSONLD: true,
	}).parse();
	for (const element of document.querySelectorAll(
		"script,style,noscript,nav,header,footer,aside,form,button,input,dialog,[hidden],[aria-hidden=true]",
	))
		element.remove();
	const root = document.querySelector("main,article,[role=main]") ?? document.body;
	const content = article?.content?.trim() ? article.content : (root?.innerHTML ?? "");
	const { document: cleaned } = parseHTML(`<html><body>${content}</body></html>`);
	const textContent = cleaned.body.textContent?.trim() ?? "";
	const shell =
		!textContent ||
		(textContent.length < 200 &&
			/^(?:loading[.\s…]*|(?:please )?enable javascript.*|you need to enable javascript.*)$/i.test(textContent));
	const method = article?.content?.trim() ? "readability" : "dom";
	source.strategy = source.strategy === "browser" ? `browser-${method}` : method;
	source.title = article?.title || title;
	const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	markdown.addRule("tables", {
		filter: "table",
		replacement: (_content, node) => {
			const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
				Array.from(row.querySelectorAll("th,td")).map((cell) =>
					(cell.textContent ?? "")
						.trim()
						.replace(/\|/g, "\\|")
						.replace(/\s*\n\s*/g, " "),
				),
			);
			if (!rows.length) return "";
			const width = Math.max(...rows.map((row) => row.length));
			const lines = rows.map(
				(row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`,
			);
			lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
			return `\n\n${lines.join("\n")}\n\n`;
		},
	});
	let body: string;
	if (plain) {
		for (const element of cleaned.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,tr,pre,blockquote,br")) {
			element.before(cleaned.createTextNode("\n"));
			element.after(cleaned.createTextNode("\n"));
		}
		for (const element of cleaned.querySelectorAll("td,th")) element.after(cleaned.createTextNode("\t"));
		body = (cleaned.body.textContent ?? "").replace(/\n[ \t]*\n[ \t]*\n/g, "\n\n").trim();
	} else body = markdown.turndown(content);
	const warning = shell
		? "Unreadable or JavaScript-only page. No automatic browser fallback was attempted; use strategy:browser explicitly."
		: login
			? "Partial page: a login form is present; authenticated content may be unavailable. The browser strategy uses a fresh profile, not your login."
			: "";
	return {
		status: shell ? "unreadable" : login ? "partial" : "ok",
		text: `URL: ${source.finalUrl}\nTitle: ${source.title}\nExtraction: ${source.strategy}${warning ? `\nWarning: ${warning}` : ""}\n\n${body}`,
		images: [],
		source,
	};
}

async function renderBrowser(request: ReaderRequest, url: string): Promise<ReaderResult> {
	if (request.pages || request.format === "images")
		throw new Error("Browser strategy extracts HTML; use auto for PDF URLs");
	const executablePath = await findBrowser(request.browserExecutablePath);
	const configuredProxy =
		process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	const proxy = configuredProxy ? new URL(configuredProxy) : undefined;
	const server = await chromium.launchServer({
		executablePath,
		headless: true,
		chromiumSandbox: true,
		host: "127.0.0.1",
		...(proxy
			? {
					proxy: {
						server: `${proxy.protocol}//${proxy.host}`,
						username: decodeURIComponent(proxy.username),
						password: decodeURIComponent(proxy.password),
						bypass: process.env.NO_PROXY ?? process.env.no_proxy,
					},
				}
			: {}),
		timeout: 15_000,
	});
	const pid = server.process().pid;
	if (pid) process.send?.({ event: "browser", pid });
	try {
		const browser = await chromium.connect(server.wsEndpoint());
		try {
			const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
			const page = await context.newPage();
			await page.route("**/*", async (route) => {
				const protocol = new URL(route.request().url()).protocol;
				if (["http:", "https:", "data:", "blob:"].includes(protocol)) await route.continue();
				else await route.abort();
			});
			const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
			if (response && !response.ok()) throw new Error(`Browser HTTP ${response.status()}: ${page.url()}`);
			let settled = true;
			try {
				await page.waitForLoadState("networkidle", { timeout: 5000 });
			} catch (error) {
				if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
				settled = false;
			}
			const finalUrl = httpUrl(page.url());
			const html = await page.content();
			if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new Error("Rendered HTML exceeds 16 MiB");
			const result = extractHtml(
				html,
				{
					kind: "web",
					url,
					finalUrl,
					strategy: "browser",
					title: "",
					statusCode: response?.status() ?? 0,
					contentType: "text/html",
				},
				request.format === "text",
			);
			if (!settled) {
				if (result.status === "ok") result.status = "partial";
				result.text = `Warning: page did not become network-idle within 5 seconds; rendered content may still be changing.\n${result.text}`;
			}
			return result;
		} finally {
			await browser.close();
		}
	} finally {
		await server.close();
		if (pid) process.send?.({ event: "browser-closed", pid });
	}
}

async function findBrowser(configured: string | undefined): Promise<string> {
	if (configured) {
		const path = resolve(configured);
		await access(path, constants.X_OK);
		return path;
	}
	const candidates =
		process.platform === "darwin"
			? ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Helium"].flatMap((name) => [
					`/Applications/${name}.app/Contents/MacOS/${name}`,
					join(homedir(), "Applications", `${name}.app`, "Contents", "MacOS", name),
				])
			: process.platform === "win32"
				? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
						.filter((root): root is string => Boolean(root))
						.flatMap((root) => [
							join(root, "Google", "Chrome", "Application", "chrome.exe"),
							join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
						])
				: [];
	for (const directory of (process.env.PATH ?? "").split(delimiter))
		for (const name of process.platform === "win32"
			? ["chrome.exe", "msedge.exe", "chromium.exe"]
			: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"])
			if (directory) candidates.push(join(directory, name));
	for (const path of candidates) {
		try {
			await access(path, constants.X_OK);
			return path;
		} catch {
			/* Continue installed-browser discovery. */
		}
	}
	throw new Error(
		"No installed Chromium browser found. Install Chrome/Chromium or set read.browserExecutablePath; pi never downloads a browser.",
	);
}
