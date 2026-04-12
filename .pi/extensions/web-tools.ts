/**
 * Web Tools Extension
 *
 * Provides web_search and web_fetch tools via Jina Reader (r.jina.ai).
 * web_search proxies DuckDuckGo Lite through Jina Reader to avoid bot-blocking
 * that hits direct DDG scrapers.
 * Auto-activates when placed at ~/.pi/extensions/web-tools.ts
 *
 * SSRF Protection:
 * - Blocks IPv4: loopback (127.x.x.x), private (10.x.x.x, 172.16-31.x.x, 192.168.x.x),
 *   link-local (169.254.x.x), broadcast (0.0.0.0/8)
 * - Blocks IPv6: loopback (::1), link-local (fe80::/10), unique local (fc00::/7),
 *   IPv4-mapped (::ffff:x.x.x.x), unspecified (::)
 * - Blocks hostnames: localhost, metadata, instance-data, metadata.google, metadata.google.internal
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// SSRF Protection (inlined from ssrf-utils.ts)
// =============================================================================

/**
 * Check if an IP address is in a specified CIDR range.
 */
function isIpInCidr(ip: string, cidr: string): boolean {
	const [range, bits] = cidr.split("/");
	const mask = parseInt(bits, 10);

	const ipNum = ipToNumber(ip);
	const rangeNum = ipToNumber(range);

	if (ipNum === null || rangeNum === null) return false;

	const maskBits = mask === 0 ? 0 : 0xffffffff << (32 - mask);
	return (ipNum & maskBits) === (rangeNum & maskBits);
}

/**
 * Convert an IPv4 address string to a number.
 */
function ipToNumber(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;

	let result = 0;
	for (const part of parts) {
		const num = parseInt(part, 10);
		if (Number.isNaN(num) || num < 0 || num > 255) return null;
		result = (result << 8) | num;
	}
	return result >>> 0;
}

/**
 * Check if an IPv6 address falls within a specific CIDR range.
 */
function isIpv6InPrefix(ipParts: string[], cidrPrefix: string, cidrBits: number): boolean {
	const prefixParts: number[] = [];
	for (let i = 0; i < 8; i++) {
		const start = i * (cidrBits > 16 ? 4 : cidrBits - i * 16 > 0 ? 4 : 0);
		const end = Math.min(start + 4, cidrPrefix.length);
		if (start < cidrPrefix.length) {
			const hex = cidrPrefix.slice(start, end);
			prefixParts.push(parseInt(hex.padEnd(4, "0"), 16));
		} else {
			prefixParts.push(0);
		}
	}

	const partsToCheck = Math.ceil(cidrBits / 16);
	for (let i = 0; i < partsToCheck && i < 8; i++) {
		if (i < partsToCheck - 1) {
			if (ipParts[i] !== prefixParts[i].toString(16).padStart(4, "0")) return false;
		} else {
			const bitsInLastPart = cidrBits - i * 16;
			const mask = (0xffff << (16 - bitsInLastPart)) >>> 0;
			const ipPartNum = parseInt(ipParts[i], 16);
			const prefixPartNum = prefixParts[i];
			if ((ipPartNum & mask) !== (prefixPartNum & mask)) return false;
		}
	}
	return true;
}

/**
 * Parse an IPv6 address string into its component parts.
 */
function parseIpv6(ip: string): string[] | null {
	// Handle IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
	const ipv4Mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
	if (ipv4Mapped?.[1]) {
		const ipv4Num = ipToNumber(ipv4Mapped[1]);
		if (ipv4Num === null) return null;
		return ["0000", "0000", "0000", "0000", "0000", "ffff", ipv4Num.toString(16).padStart(4, "0")];
	}

	// Remove zone ID if present
	const zoneIndex = ip.indexOf("%");
	if (zoneIndex !== -1) {
		ip = ip.slice(0, zoneIndex);
	}

	// Handle :: expansion
	let normalized = ip;
	if (ip.includes("::")) {
		const parts = ip.split("::");
		const leftParts = parts[0] ? parts[0].split(":") : [];
		const rightParts = parts[1] ? parts[1].split(":") : [];
		const missing = 8 - leftParts.length - rightParts.length;

		const middle = Array(missing).fill("0");
		normalized = [...leftParts, ...middle, ...rightParts].join(":");
	}

	const parts = normalized.split(":");
	if (parts.length !== 8) return null;

	const result: string[] = [];
	for (const p of parts) {
		if (p === "") {
			result.push("0");
			continue;
		}
		const num = parseInt(p, 16);
		if (Number.isNaN(num) || num < 0 || num > 0xffff) return null;
		result.push(num.toString(16).padStart(4, "0").toLowerCase());
	}
	return result;
}

/**
 * Check if a hostname/IP should be blocked by SSRF protection.
 */
function isBlockedHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();

	if (lower === "localhost" || lower === "localhost.") {
		return true;
	}

	const internalHostnames = ["metadata", "instance-data", "metadata.google", "metadata.google.internal"];
	if (internalHostnames.includes(lower)) {
		return true;
	}

	return false;
}

/**
 * Check if an IP address should be blocked by SSRF protection.
 */
function isBlockedIp(ip: string): boolean {
	// Check for IPv4
	if (ip.includes(".") && !ip.includes(":")) {
		if (isIpInCidr(ip, "127.0.0.0/8")) return true;
		if (isIpInCidr(ip, "10.0.0.0/8")) return true;
		if (isIpInCidr(ip, "172.16.0.0/12")) return true;
		if (isIpInCidr(ip, "192.168.0.0/16")) return true;
		if (isIpInCidr(ip, "169.254.0.0/16")) return true;
		if (isIpInCidr(ip, "0.0.0.0/8")) return true;
		return false;
	}

	// Check for IPv6
	const ipv6Parts = parseIpv6(ip);
	if (ipv6Parts === null) {
		return true;
	}

	// Loopback: ::1
	if (ipv6Parts.join(":") === "0000:0000:0000:0000:0000:0000:0000:0001") {
		return true;
	}

	// IPv4-mapped IPv6: ::ffff:x.x.x.x
	if (ipv6Parts.slice(0, 5).join(":") === "0000:0000:0000:0000:0000" && ipv6Parts[5] === "ffff") {
		const mappedIp = `${parseInt(ipv6Parts[6].slice(0, 2), 16)}.${parseInt(ipv6Parts[6].slice(2), 16)}.${parseInt(ipv6Parts[7].slice(0, 2), 16)}.${parseInt(ipv6Parts[7].slice(2), 16)}`;
		return isBlockedIp(mappedIp);
	}

	// IPv6 link-local: fe80::/10
	if (isIpv6InPrefix(ipv6Parts, "fe80", 10)) {
		return true;
	}

	// IPv6 unique local: fc00::/7 (includes fc00::/8 and fd00::/8)
	if (isIpv6InPrefix(ipv6Parts, "fc", 7)) {
		return true;
	}

	// Unspecified: ::
	if (ipv6Parts.every((p) => p === "0000")) {
		return true;
	}

	return false;
}

/**
 * Check if a URL should be blocked by SSRF protection.
 */
function isUrlBlocked(url: URL): boolean {
	const hostname = url.hostname;

	if (isBlockedHostname(hostname)) {
		return true;
	}

	// Check if hostname is an IP address (IPv4, IPv6, or IPv4-mapped)
	const ipPattern = /^[\d.:[\]]+$/;
	if (ipPattern.test(hostname)) {
		const ip = hostname.replace(/^\[|\]$/g, "");
		if (isBlockedIp(ip)) {
			return true;
		}
	}

	// Also check for IPv6 hex format (e.g., ::ffff:7f00:1)
	if (hostname.startsWith("[") && hostname.includes(":") && hostname.endsWith("]")) {
		const ip = hostname.slice(1, -1);
		if (isBlockedIp(ip)) {
			return true;
		}
	}

	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return true;
	}

	return false;
}

// =============================================================================
// Web Search (DDG Lite proxied through Jina Reader)
// =============================================================================

interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Raised when a search backend returns an anti-bot challenge page. */
class SearchBlockedError extends Error {
	constructor(message = "Search backend blocked the request") {
		super(message);
		this.name = "SearchBlockedError";
	}
}

/** Markers that indicate DuckDuckGo served an anti-bot interstitial instead of real results. */
const ANOMALY_MARKERS = ["anomaly.js", "Unfortunately, bots", "challenge-form"];

/**
 * Decode a DuckDuckGo redirector URL (//duckduckgo.com/l/?uddg=<encoded>&...).
 * Returns the original URL on success, or null if the input is not a DDG redirector.
 */
function decodeDuckDuckGoRedirect(href: string): string | null {
	try {
		const normalized = href.startsWith("//") ? `https:${href}` : href;
		const parsed = new URL(normalized);
		if (!parsed.hostname.endsWith("duckduckgo.com")) return null;
		const uddg = parsed.searchParams.get("uddg");
		if (!uddg) return null;
		return decodeURIComponent(uddg);
	} catch {
		return null;
	}
}

/**
 * Resolve a result URL: decode DDG redirectors, pass everything else through.
 */
function resolveResultUrl(href: string): string {
	const decoded = decodeDuckDuckGoRedirect(href);
	if (decoded) return decoded;
	if (href.startsWith("//")) return `https:${href}`;
	return href;
}

/** True if the URL should be filtered out as DDG navigation/chrome, not a real result. */
function isNavigationUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
			// Skip DDG's own pages unless it's a redirect we've already decoded
			return true;
		}
		return false;
	} catch {
		return true;
	}
}

/**
 * Parse Jina-converted DDG Lite markdown into structured results.
 *
 * DDG Lite returns a very simple HTML table of results. Jina's markdown output
 * preserves links as `[text](url)` and text runs between them. We walk the
 * markdown, collect every link, decode DDG redirectors, and pair each link
 * with the text that follows it (up to the next link or blank line) as the snippet.
 *
 * This parser is deliberately tolerant: if Jina's exact output shape drifts,
 * we still extract usable title+url pairs and fall back to empty snippets.
 */
function parseJinaSearchMarkdown(markdown: string, maxResults: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;

	const matches: Array<{ title: string; url: string; start: number; end: number }> = [];
	let m: RegExpExecArray | null = linkPattern.exec(markdown);
	while (m !== null) {
		const title = m[1].trim();
		const rawHref = m[2].trim();
		const url = resolveResultUrl(rawHref);
		if (title && url && !isNavigationUrl(url)) {
			matches.push({ title, url, start: m.index, end: m.index + m[0].length });
		}
		m = linkPattern.exec(markdown);
	}

	// Deduplicate by URL, preserve first occurrence
	const seen = new Set<string>();
	for (let i = 0; i < matches.length && results.length < maxResults; i++) {
		const current = matches[i];
		if (seen.has(current.url)) continue;
		seen.add(current.url);

		// Snippet: text between this link's end and the next match's start
		const nextStart = i + 1 < matches.length ? matches[i + 1].start : markdown.length;
		const between = markdown.slice(current.end, nextStart);
		let domain: string | undefined;
		try {
			domain = new URL(current.url).hostname.replace(/^www\./, "");
		} catch {
			/* ignore */
		}
		const snippet = between
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => {
				if (l.length === 0) return false;
				if (l.startsWith("[") || l.startsWith("#") || l.startsWith("---") || l.startsWith("!")) return false;
				if (/^\d+\.$/.test(l)) return false;
				if (domain && (l === domain || l === `www.${domain}` || l.startsWith(`${domain}/`) || l.startsWith(`www.${domain}/`)))
					return false;
				return true;
			})
			.join(" ")
			.replace(/\*\*/g, "")
			.replace(/\s*\d+\.\s*$/, "")
			.slice(0, 300)
			.trim();

		results.push({ title: current.title, url: current.url, snippet });
	}

	return results;
}

/**
 * Search by proxying DuckDuckGo Lite through Jina Reader.
 *
 * Using Jina Reader as the fetch layer sidesteps DDG's bot-detection of direct
 * scrapers (DDG returns an "anomaly" page for `Mozilla/5.0 (compatible; PiBot/1.0)`
 * and similar UAs). Jina Reader fetches from its own IP pool with proper rendering
 * and returns the resulting page as clean markdown, which we then parse.
 */
async function searchViaJinaReader(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<WebSearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;
	const jinaUrl = `https://r.jina.ai/${ddgUrl}`;

	const headers: Record<string, string> = {
		Accept: "text/markdown, text/plain",
		"X-Return-Format": "markdown",
		"User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)",
	};
	if (process.env.JINA_API_KEY) {
		headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
	}

	const response = await fetch(jinaUrl, { signal, headers });

	if (!response.ok) {
		if (response.status === 429) {
			throw new Error("Rate limit exceeded");
		}
		throw new Error(`Search failed: HTTP ${response.status}`);
	}

	const markdown = await response.text();

	if (ANOMALY_MARKERS.some((marker) => markdown.includes(marker))) {
		throw new SearchBlockedError();
	}

	return parseJinaSearchMarkdown(markdown, maxResults);
}

// =============================================================================
// Jina Reader Fetch
// =============================================================================

interface FetchResult {
	title: string;
	content: string;
}

const METADATA_PREFIXES = [
	"title:",
	"url:",
	"description:",
	"image:",
	"publishedtime:",
	"author:",
	"domain:",
	"locale:",
	"canonical:",
];

const MAX_TITLE_LENGTH = 100;
const CONTENT_TRUNCATE_LIMIT = 4096;

/**
 * Fetch a URL using Jina Reader and return the content as markdown.
 */
async function fetchWithJinaReader(url: string, signal?: AbortSignal): Promise<FetchResult> {
	const jinaUrl = `https://r.jina.ai/${url}`;

	const response = await fetch(jinaUrl, {
		signal,
		headers: {
			Accept: "text/markdown, text/plain",
			"X-Return-Format": "markdown",
			"User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)",
		},
	});

	if (!response.ok) {
		if (response.status === 429) {
			throw new Error("Rate limit exceeded");
		}
		if (response.status === 404) {
			throw new Error("Page not found");
		}
		throw new Error(`Fetch failed: HTTP ${response.status}`);
	}

	const content = await response.text();

	return {
		title: "",
		content,
	};
}

/**
 * Strip metadata prefix lines from Jina Reader content.
 */
function stripMetadataPrefix(content: string): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let metadataEnded = false;

	for (const line of lines) {
		const trimmed = line.trim().toLowerCase();
		const isMetadata = METADATA_PREFIXES.some((prefix) => trimmed.startsWith(prefix));

		if (!isMetadata) {
			metadataEnded = true;
		}

		if (metadataEnded && !isMetadata) {
			result.push(line);
		}
	}

	return result.join("\n").trim();
}

/**
 * Extract the title from markdown content.
 */
function extractTitleFromMarkdown(content: string, fallbackTitle?: string): string {
	const headingMatch = content.match(/^#\s+(.+)$/m);
	if (headingMatch) {
		let title = headingMatch[1].trim();
		title = title.replace(/\*\*(.+?)\*\*/g, "$1");
		title = title.replace(/\*(.+?)\*/g, "$1");
		title = title.replace(/\[(.+?)\]\(.+?\)/g, "$1");
		title = title.replace(/`(.+?)`/g, "$1");
		return title.slice(0, MAX_TITLE_LENGTH);
	}

	return fallbackTitle ?? "Untitled";
}

/**
 * Derive a title from a URL path.
 */
function deriveTitleFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname;

		const segments = path.split("/").filter((s) => s.length > 0);
		if (segments.length === 0) {
			return undefined;
		}

		const lastSegment = segments[segments.length - 1];
		const withoutExt = lastSegment.replace(/\.[^.]+$/, "");

		if (!withoutExt || /^(index|default|home|page)$/i.test(withoutExt)) {
			return undefined;
		}

		const title = withoutExt.replace(/[-_]/g, " ");
		return title;
	} catch {
		return undefined;
	}
}

/**
 * Truncate content to a maximum length.
 */
function truncateContent(
	content: string,
	maxLength: number = CONTENT_TRUNCATE_LIMIT,
): { content: string; truncated: boolean } {
	if (content.length <= maxLength) {
		return { content, truncated: false };
	}

	return {
		content: `${content.slice(0, maxLength)}\n\n[truncated]`,
		truncated: true,
	};
}

/**
 * Check if content is HTML-only with no meaningful text.
 */
function isHtmlOnlyContent(content: string): boolean {
	const withoutTags = content.replace(/<[^>]*>/g, "").trim();
	return withoutTags.length === 0;
}

/**
 * Format an error as a user-friendly error string.
 */
function formatError(message: string): string {
	return `Error: ${message}`;
}

// =============================================================================
// Extension Registration
// =============================================================================

export default function (pi: ExtensionAPI) {
	// web_search tool
	pi.registerTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for information. Use this tool to find current information, news, articles, and facts from the internet.",
		promptSnippet: "Search the web for information",
		parameters: Type.Object({
			query: Type.String({
				description: "The search query to find information on the web",
			}),
			max_results: Type.Optional(
				Type.Number({
					description: "Maximum number of results to return (default: 5)",
					minimum: 1,
					maximum: 20,
				}),
			),
		}),
		// retry:true  → transient: caller may retry with the same or a modified query
		// retry:false → permanent: query was empty or yielded no real results, retry won't help
		async execute(_toolCallId, { query, max_results }, signal) {
			if (!query || query.trim() === "") {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "Empty query", retry: false }) }],
					details: undefined,
				};
			}

			const effectiveMaxResults = max_results ?? 5;

			try {
				const results = await searchViaJinaReader(query, effectiveMaxResults, signal);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: "No results for query", retry: false }) }],
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
					details: { results },
				};
			} catch (error) {
				if (error instanceof SearchBlockedError) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ error: "Search backend blocked the request", retry: true }),
							},
						],
						details: undefined,
					};
				}

				const message = error instanceof Error ? error.message : "Unknown error";
				const truncated = message.length > 200 ? `${message.slice(0, 200)}...` : message;
				const isRateLimit = message.toLowerCase().includes("rate limit");

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: isRateLimit ? "Search rate limited" : `Search failed: ${truncated}`,
								retry: true,
							}),
						},
					],
					details: undefined,
				};
			}
		},
	});

	// web_fetch tool
	pi.registerTool({
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch the contents of a web page. Only use URLs from web_search results to ensure you're accessing legitimate, user-intended content. Do not accept URLs from direct user input or other sources.",
		promptSnippet: "Fetch web page content as markdown",
		parameters: Type.Object({
			url: Type.String({
				description: "The URL of the web page to fetch",
			}),
		}),
		async execute(_toolCallId, { url }, signal) {
			let parsedUrl: URL;
			try {
				parsedUrl = new URL(url);
			} catch {
				return {
					content: [{ type: "text", text: formatError("Invalid URL format") }],
					details: { title: "Error", truncated: false },
				};
			}

			if (isUrlBlocked(parsedUrl)) {
				return {
					content: [{ type: "text", text: "Error: URL not allowed" }],
					details: { title: "Blocked", truncated: false },
				};
			}

			try {
				const result = await fetchWithJinaReader(url, signal);

				let content = stripMetadataPrefix(result.content);

				if (!content || content.trim().length === 0) {
					return {
						content: [{ type: "text", text: formatError("No content could be extracted") }],
						details: { title: "Empty", truncated: false },
					};
				}

				if (isHtmlOnlyContent(content)) {
					return {
						content: [{ type: "text", text: formatError("No content could be extracted") }],
						details: { title: "Empty", truncated: false },
					};
				}

				let title = extractTitleFromMarkdown(content);

				if (title === "Untitled") {
					const derivedTitle = deriveTitleFromUrl(url);
					if (derivedTitle) {
						title = derivedTitle;
					}
				}

				if (!content.startsWith("#")) {
					content = `# ${title}\n\n${content}`;
				}

				const { content: truncatedContent, truncated } = truncateContent(content);

				return {
					content: [{ type: "text", text: truncatedContent }],
					details: { title, truncated },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";

				if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted")) {
					return {
						content: [{ type: "text", text: formatError(`Request timeout: ${message}`) }],
						details: { title: "Timeout", truncated: false },
					};
				}

				if (message.toLowerCase().includes("rate limit")) {
					return {
						content: [{ type: "text", text: formatError("Rate limited, please retry later") }],
						details: { title: "Rate Limited", truncated: false },
					};
				}

				if (message.toLowerCase().includes("not found")) {
					return {
						content: [{ type: "text", text: formatError("Page not found (404)") }],
						details: { title: "Not Found", truncated: false },
					};
				}

				return {
					content: [{ type: "text", text: formatError(`Fetch failed: ${message}`) }],
					details: { title: "Error", truncated: false },
				};
			}
		},
	});
}
