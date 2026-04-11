/**
 * Web Tools Extension
 *
 * Provides web_search and web_fetch tools via DuckDuckGo HTML and Jina Reader.
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
// DuckDuckGo Search
// =============================================================================

interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Regular expression to decode HTML entities */
const HTML_ENTITY_REGEX = /&#(\d+);|&#x([0-9a-fA-F]+);|&#([a-zA-Z]+);|&([a-zA-Z]+);/g;

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(str: string): string {
	return str.replace(HTML_ENTITY_REGEX, (_match, dec, hex, namedRef, named) => {
		if (dec !== undefined) {
			return String.fromCharCode(parseInt(dec, 10));
		}
		if (hex !== undefined) {
			return String.fromCharCode(parseInt(hex, 16));
		}
		if (namedRef !== undefined) {
			return decodeNamedEntity(namedRef);
		}
		if (named !== undefined) {
			return decodeNamedEntity(named);
		}
		return _match;
	});
}

/** Map of common HTML named entities */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "\u0026",
	lt: "\u003c",
	gt: "\u003e",
	quot: "\u0022",
	apos: "\u0027",
	nbsp: "\u00a0",
	ndash: "\u2013",
	mdash: "\u2014",
	hellip: "\u2026",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
	ldquo: "\u201c",
	rdquo: "\u201d",
	lsquo: "\u2018",
	rsquo: "\u2019",
	bull: "\u2022",
	prime: "\u2032",
	Prime: "\u2033",
	deg: "\u00b0",
	plusmn: "\u00b1",
	frac14: "\u00bc",
	frac12: "\u00bd",
	frac34: "\u00be",
	times: "\u00d7",
	divide: "\u00f7",
	forall: "\u2200",
	exist: "\u2203",
	empty: "\u2205",
	infin: "\u221e",
	sum: "\u2211",
	prod: "\u220f",
	part: "\u2202",
	nabla: "\u2207",
	ne: "\u2260",
	le: "\u2264",
	ge: "\u2265",
	mu: "\u03bc",
	alpha: "\u03b1",
	beta: "\u03b2",
	gamma: "\u03b3",
	delta: "\u03b4",
	epsilon: "\u03b5",
	theta: "\u03b8",
	lambda: "\u03bb",
	pi: "\u03c0",
	sigma: "\u03c3",
	phi: "\u03c6",
	omega: "\u03c9",
};

/**
 * Decode a named HTML entity.
 */
function decodeNamedEntity(name: string): string {
	return NAMED_ENTITIES[name] ?? `&${name};`;
}

/**
 * Extract text content from an HTML string, stripping tags.
 */
function extractText(html: string): string {
	let text = html.replace(/<[^>]*>/g, "");
	text = decodeHtmlEntities(text);
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

/**
 * Search DuckDuckGo for the given query.
 */
async function searchDuckDuckGo(
	query: string,
	maxResults: number = 5,
	signal?: AbortSignal,
): Promise<WebSearchResult[]> {
	const encodedQuery = encodeURIComponent(query);
	const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

	const response = await fetch(url, {
		signal,
		headers: {
			Accept: "text/html",
			"User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)",
		},
	});

	if (!response.ok) {
		if (response.status === 429) {
			throw new Error("Rate limit exceeded");
		}
		throw new Error(`Search failed: HTTP ${response.status}`);
	}

	const html = await response.text();
	return parseDuckDuckGoHtml(html, maxResults);
}

/**
 * Parse DuckDuckGo HTML search results into structured data.
 */
function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];

	const resultLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

	resultLinkPattern.lastIndex = 0;
	let match: RegExpExecArray | null = resultLinkPattern.exec(html);
	while (match !== null) {
		const url = decodeHtmlEntities(match[1]);
		const titleHtml = match[2];
		const title = extractText(titleHtml);

		if (!title || !url) {
			match = resultLinkPattern.exec(html);
			continue;
		}

		const afterResult = html.slice(match.index + match[0].length);
		const snippetMatch = snippetPattern.exec(afterResult);
		const snippet = snippetMatch ? extractText(snippetMatch[1]) : "";

		results.push({ title, url, snippet });

		snippetPattern.lastIndex = 0;
		match = resultLinkPattern.exec(html);
	}

	return results.slice(0, maxResults);
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
		async execute(_toolCallId, { query, max_results }, signal) {
			if (!query || query.trim() === "") {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "Empty query", retry: false }) }],
					details: undefined,
				};
			}

			const effectiveMaxResults = max_results ?? 5;

			try {
				const results = await searchDuckDuckGo(query, effectiveMaxResults, signal);

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: "Search failed", retry: false }) }],
						details: undefined,
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
					details: { results },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				const isRateLimit = message.toLowerCase().includes("rate limit");

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: isRateLimit ? "Search rate limited" : "Search failed",
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
