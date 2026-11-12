// Fetch bounded web documents, or explicitly render a leased tab in the Pi-owned project browser.
/// <reference lib="dom" />

import { setTimeout as delay } from "node:timers/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { chromium, type Frame, type Page } from "playwright-core";
import TurndownService from "turndown";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { readPdf } from "./pdf.ts";
import { MAX_READER_INPUT_BYTES, type ReaderRequest, type ReaderResult } from "./protocol.ts";

const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_BLOCK_PAGE_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 10_000;

/** Fetch and extract a URL without running JavaScript unless browser was explicitly selected. */
export async function readWeb(request: ReaderRequest): Promise<ReaderResult> {
	const url = httpUrl(request.path);
	if (request.strategy === "browser") return renderBrowser(request, url);
	if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
		setGlobalDispatcher(new EnvHttpProxyAgent());
	const deadline = Date.now() + 20_000;
	const signal = AbortSignal.timeout(20_000);
	let current = url;
	let redirects = 0;
	let retried403 = false;
	let retried429 = false;
	const retries: string[] = [];
	for (;;) {
		const response = await fetch(current, {
			redirect: "manual",
			signal,
			headers: {
				Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/pdf;q=0.7, */*;q=0.1",
				"User-Agent": retried403 ? BROWSER_USER_AGENT : "pi-read/1.0",
			},
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location) throw new Error(`HTTP ${response.status} without a redirect location`);
			if (++redirects > 5) throw new Error("HTTP redirect limit exceeded (5)");
			current = httpUrl(new URL(location, current).href);
			continue;
		}
		if (response.status === 403 && !retried403) {
			await response.body?.cancel();
			retried403 = true;
			retries.push("retried HTTP 403 once with a browser User-Agent");
			continue;
		}
		if (response.status === 429 && !retried429) {
			const wait = retryAfterMs(response.headers.get("retry-after"));
			if (wait <= MAX_RETRY_AFTER_MS && wait < deadline - Date.now()) {
				await response.body?.cancel();
				retried429 = true;
				retries.push(`retried HTTP 429 once after ${wait} ms without changing User-Agent`);
				await delay(wait, undefined, { signal });
				continue;
			}
			retries.push("HTTP 429 retry skipped: Retry-After exceeds the remaining deadline or 10-second retry budget");
		}
		if (!response.ok || response.headers.get("cf-mitigated") === "challenge") {
			throw await httpFailure(response, current, retries);
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
}

function retryAfterMs(value: string | null): number {
	if (!value?.trim()) return 1000;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = /^[a-z]/i.test(trimmed) ? Date.parse(trimmed) : NaN;
	return Number.isNaN(date) ? 1000 : Math.max(0, date - Date.now());
}

async function httpFailure(response: Response, url: string, retries: readonly string[]): Promise<Error> {
	let blockedBy = response.headers.get("cf-mitigated") === "challenge" ? "Cloudflare" : undefined;
	if (!blockedBy && /(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get("content-type") ?? "")) {
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (reader && size < MAX_BLOCK_PAGE_BYTES) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = value.subarray(0, MAX_BLOCK_PAGE_BYTES - size);
				chunks.push(chunk);
				size += chunk.byteLength;
			}
			blockedBy = botProtection(parseHTML(Buffer.concat(chunks, size).toString("utf8")).document);
		} catch {
			// A broken error body must not hide the server's HTTP status.
		} finally {
			await reader?.cancel().catch(() => {});
			reader?.releaseLock();
		}
	} else await response.body?.cancel();
	return new Error(
		[
			`HTTP ${response.status} ${response.statusText}: ${url}`,
			...retries,
			...(blockedBy ? [`Bot protection detected (${blockedBy})`] : []),
			...(blockedBy || response.status === 403
				? [
						'For a public page blocked by bot protection, try strategy:"browser" explicitly; it uses a Pi-owned project profile, not your personal browser, and does not grant access to restricted content.',
					]
				: []),
		].join("; "),
	);
}

/** Recognize live challenge markup or a short interstitial, not an article quoting a challenge. */
function botProtection(document: Document): string | undefined {
	for (const element of document.querySelectorAll("template")) element.remove();
	if (document.querySelector('input[name="js_challenge"]')) return "JavaScript challenge";
	if (document.querySelector("#challenge-form,#cf-challenge-running")) return "Cloudflare";
	for (const element of document.querySelectorAll("script,style,pre,code")) element.remove();
	const text = document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
	if (text.length > 2048) return undefined;
	const heading = document.querySelector("h1,h2")?.textContent?.trim() ?? "";
	const interstitial =
		/^(?:just a moment[.!…]*|attention required!?\s*\|\s*cloudflare|verify (?:that )?you are human[.!?]*|security verification|robot check|access denied|access to this page has been denied)[.!?]*$/i;
	if (interstitial.test(document.title.trim()) || interstitial.test(heading) || interstitial.test(text))
		return "bot challenge or access-denied page";
	return undefined;
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
	// Inspect a separate DOM: challenge detection removes quoted code and must not change the article.
	const blockedBy =
		Buffer.byteLength(html) <= MAX_BLOCK_PAGE_BYTES ? botProtection(parseHTML(html).document) : undefined;
	if (blockedBy) {
		source.title = document.title ?? "";
		source.strategy = source.strategy === "browser" ? "browser-blocked" : "blocked";
		return {
			status: "unreadable",
			text: `URL: ${source.finalUrl}\nTitle: ${source.title}\nExtraction: ${source.strategy}\nWarning: Bot protection detected (${blockedBy}); this is not the requested document. No automatic browser fallback was attempted; strategy:browser explicitly uses an installed browser with a Pi-owned project profile, not your personal browser.`,
			images: [],
			source,
		};
	}
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
			? "Partial page: a login form is present; authenticated content may be unavailable. The browser strategy shares a persistent Pi-owned project profile, not your personal browser or its login."
			: "";
	return {
		status: shell ? "unreadable" : login ? "partial" : "ok",
		text: `URL: ${source.finalUrl}\nTitle: ${source.title}\nExtraction: ${source.strategy}${warning ? `\nWarning: ${warning}` : ""}\n\n${body}`,
		images: [],
		source,
	};
}

async function navigateLeasedPage(page: Page, url: string, marker: string) {
	const blankReload = Promise.withResolvers<void>();
	const onNavigation = (frame: Frame) => {
		if (frame === page.mainFrame() && frame.url() === marker) blankReload.resolve();
	};
	page.on("framenavigated", onNavigation);
	const navigate = () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
	try {
		return await navigate().catch(async (error: unknown) => {
			// A bundled extension can reload a newly attached blank tab during startup. Wait for
			// that reload to commit before retrying once; never retry a navigation to other content.
			if (
				!(error instanceof Error) ||
				(!error.message.includes("net::ERR_ABORTED") &&
					!error.message.includes(`another navigation to "${marker}"`)) ||
				page.url() !== marker
			)
				throw error;
			const timer = setTimeout(() => blankReload.reject(error), 1000);
			try {
				await blankReload.promise;
			} finally {
				clearTimeout(timer);
			}
			await page.waitForLoadState("load", { timeout: 5000 });
			return navigate();
		});
	} finally {
		page.removeListener("framenavigated", onNavigation);
	}
}

async function renderBrowser(request: ReaderRequest, url: string): Promise<ReaderResult> {
	if (request.pages || request.format === "images")
		throw new Error("Browser strategy extracts HTML; use auto for PDF URLs");
	const connection = request.browserConnection;
	if (!connection) throw new Error("Browser reads require a Pi-owned project browser lease");
	const browser = await chromium.connectOverCDP(connection.endpoint, { timeout: 15_000, noDefaults: true });
	try {
		const page = browser
			.contexts()[0]
			?.pages()
			.find((candidate) => candidate.url() === connection.pageUrl);
		if (!page) throw new Error("The leased project browser tab is no longer available");
		const response = await navigateLeasedPage(page, url, connection.pageUrl);
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
		// connectOverCDP.close() disconnects this helper; the broker owns the tab and browser lifetime.
		await browser.close();
	}
}
