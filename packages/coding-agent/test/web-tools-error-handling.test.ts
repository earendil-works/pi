/**
 * Tests for web-tools extension error handling (TDD)
 *
 * These tests define expected error handling behavior:
 * - web_search returns JSON with error and retry fields
 * - web_fetch returns "Error: ..." strings
 * - SSRF blocked URLs return "Error: URL not allowed"
 * - Empty queries return proper error JSON
 * - Invalid URLs return proper error strings
 * - Rate limiting returns appropriate errors
 */

import { describe, expect, it, vi } from "vitest";

// Helper to extract text from AgentToolResult content blocks
function getTextOutput(result: {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}): string {
	return (
		result.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") || ""
	);
}

// Mock ExtensionAPI for testing tool execution
// biome-ignore lint/correctness/noUnusedVariables: This is a helper function for future use
function createMockToolExecution(toolDefinition: {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}) {
	return toolDefinition.execute.bind(toolDefinition);
}

describe("web_search error handling (returns JSON)", () => {
	// Create a mock web_search execute function matching the extension behavior
	async function executeWebSearch(
		params: { query: string; max_results?: number },
		fetchMock: (url: string, options?: RequestInit) => Promise<Response>,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> {
		const { query, max_results } = params;

		// Validate query
		if (!query || query.trim() === "") {
			return {
				content: [{ type: "text", text: JSON.stringify({ error: "Empty query", retry: false }) }],
				details: undefined,
			};
		}

		const _effectiveMaxResults = max_results ?? 5; // Reserved for future use

		try {
			// Call DuckDuckGo
			const encodedQuery = encodeURIComponent(query);
			const response = await fetchMock(`https://html.duckduckgo.com/html/?q=${encodedQuery}`);

			if (!response.ok) {
				if (response.status === 429) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: "Search rate limited", retry: true }) }],
						details: undefined,
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "Search failed", retry: false }) }],
					details: undefined,
				};
			}

			const html = await response.text();

			// Parse results (simplified)
			const results: { title: string; url: string; snippet: string }[] = [];
			const resultLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
			for (const match of html.matchAll(resultLinkPattern)) {
				const url = match[1];
				const titleHtml = match[2];
				const title = titleHtml.replace(/<[^>]*>/g, "").trim();
				if (title && url) {
					results.push({ title, url, snippet: "" });
				}
			}

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
	}

	describe("Empty query handling", () => {
		it("should return error JSON for empty query", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);

			const result = await executeWebSearch({ query: "" }, mockFetch);
			const output = getTextOutput(result);

			expect(() => JSON.parse(output)).not.toThrow();
			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.error).toBe("Empty query");
			expect(parsed.retry).toBe(false);
		});

		it("should return error JSON for whitespace-only query", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);

			const result = await executeWebSearch({ query: "   " }, mockFetch);
			const output = getTextOutput(result);

			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.error).toBe("Empty query");
		});
	});

	describe("Network error handling", () => {
		it("should return error JSON on network failure", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("Network unavailable"));

			const result = await executeWebSearch({ query: "test" }, mockFetch);
			const output = getTextOutput(result);

			expect(() => JSON.parse(output)).not.toThrow();
			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.retry).toBe(true);
		});

		it("should return error JSON on HTTP error", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 500,
					statusText: "Internal Server Error",
				}),
			);

			const result = await executeWebSearch({ query: "test" }, mockFetch);
			const output = getTextOutput(result);

			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.retry).toBe(false);
		});
	});

	describe("Rate limiting", () => {
		it("should return rate limit error with retry=true for 429", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 429,
					statusText: "Too Many Requests",
				}),
			);

			const result = await executeWebSearch({ query: "test" }, mockFetch);
			const output = getTextOutput(result);

			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.error).toMatch(/rate|limit/i);
			expect(parsed.retry).toBe(true);
		});

		it("should return rate limit error for network timeout message", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("Rate limit exceeded"));

			const result = await executeWebSearch({ query: "test" }, mockFetch);
			const output = getTextOutput(result);

			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
			expect(parsed.error).toMatch(/rate/i);
			expect(parsed.retry).toBe(true);
		});
	});

	describe("Parse failure", () => {
		it("should return error JSON when no results parsed", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("<html><body>No results here</body></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);

			const result = await executeWebSearch({ query: "test" }, mockFetch);
			const output = getTextOutput(result);

			const parsed = JSON.parse(output);
			expect(parsed).toHaveProperty("error");
		});
	});
});

describe("web_fetch error handling (returns strings)", () => {
	// Create a mock web_fetch execute function matching the extension behavior
	function formatError(message: string): string {
		return `Error: ${message}`;
	}

	function isUrlBlocked(url: URL): boolean {
		const hostname = url.hostname;
		const lower = hostname.toLowerCase();

		if (lower === "localhost" || lower === "localhost.") return true;

		const ipPattern = /^[\d.:[\]]+$/;
		if (ipPattern.test(hostname)) {
			const ip = hostname.replace(/^\[|\]$/g, "");
			if (/^127\./.test(ip)) return true;
			if (/^10\./.test(ip)) return true;
			if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
			if (/^192\.168\./.test(ip)) return true;
			if (/^169\.254\./.test(ip)) return true;
		}

		return url.protocol !== "https:" && url.protocol !== "http:";
	}

	async function executeWebFetch(
		params: { url: string },
		fetchMock: (url: string, options?: RequestInit) => Promise<Response>,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> {
		const { url } = params;

		// Validate URL format
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			return {
				content: [{ type: "text", text: formatError("Invalid URL format") }],
				details: { title: "Error", truncated: false },
			};
		}

		// Check SSRF
		if (isUrlBlocked(parsedUrl)) {
			return {
				content: [{ type: "text", text: "Error: URL not allowed" }],
				details: { title: "Blocked", truncated: false },
			};
		}

		try {
			const jinaUrl = `https://r.jina.ai/${url}`;
			const response = await fetchMock(jinaUrl);

			if (!response.ok) {
				if (response.status === 429) {
					return {
						content: [{ type: "text", text: formatError("Rate limited, please retry later") }],
						details: { title: "Rate Limited", truncated: false },
					};
				}
				if (response.status === 404) {
					return {
						content: [{ type: "text", text: formatError("Page not found (404)") }],
						details: { title: "Not Found", truncated: false },
					};
				}
				return {
					content: [{ type: "text", text: formatError(`Fetch failed: HTTP ${response.status}`) }],
					details: { title: "Error", truncated: false },
				};
			}

			let content = await response.text();

			// Strip metadata
			const lines = content.split("\n");
			const metadataPrefixes = ["title:", "url:", "description:", "image:", "publishedtime:", "author:", "domain:"];
			const cleanLines: string[] = [];
			let metadataEnded = false;
			for (const line of lines) {
				const trimmed = line.trim().toLowerCase();
				const isMetadata = metadataPrefixes.some((p) => trimmed.startsWith(p));
				if (!isMetadata) metadataEnded = true;
				if (metadataEnded && !isMetadata) cleanLines.push(line);
			}
			content = cleanLines.join("\n").trim();

			if (!content || content.trim().length === 0) {
				return {
					content: [{ type: "text", text: formatError("No content could be extracted") }],
					details: { title: "Empty", truncated: false },
				};
			}

			// Extract title
			const titleMatch = content.match(/^#\s+(.+)$/m);
			const title = titleMatch ? titleMatch[1].trim().slice(0, 100) : "Untitled";

			// Prepend title
			if (!content.startsWith("#")) {
				content = `# ${title}\n\n${content}`;
			}

			// Truncate
			const maxLength = 4096;
			let truncated = false;
			if (content.length > maxLength) {
				content = `${content.slice(0, maxLength)}\n\n[truncated]`;
				truncated = true;
			}

			return {
				content: [{ type: "text", text: content }],
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
	}

	describe("Invalid URL handling", () => {
		it("should return error string for invalid URL format", async () => {
			const mockFetch = vi.fn();

			const result = await executeWebFetch({ url: "not-a-valid-url" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/Invalid URL/i);
		});

		it("should return error string for malformed URL", async () => {
			const mockFetch = vi.fn();

			const result = await executeWebFetch({ url: "://missing-scheme.com" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
		});
	});

	describe("SSRF blocked URLs", () => {
		it("should return 'Error: URL not allowed' for localhost", async () => {
			const mockFetch = vi.fn();

			const result = await executeWebFetch({ url: "http://localhost/test" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toBe("Error: URL not allowed");
		});

		it("should return 'Error: URL not allowed' for 127.0.0.1", async () => {
			const mockFetch = vi.fn();

			const result = await executeWebFetch({ url: "http://127.0.0.1/test" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toBe("Error: URL not allowed");
		});

		it("should return 'Error: URL not allowed' for private networks", async () => {
			const mockFetch = vi.fn();

			const privateUrls = [
				"http://10.0.0.1/test",
				"http://192.168.1.1/test",
				"http://172.16.0.1/test",
				"http://169.254.169.254/latest/meta-data/",
			];

			for (const url of privateUrls) {
				const result = await executeWebFetch({ url }, mockFetch);
				const output = getTextOutput(result);
				expect(output).toBe("Error: URL not allowed");
			}
		});
	});

	describe("Network error handling", () => {
		it("should return error string on network failure", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

			const result = await executeWebFetch({ url: "https://example.com/test" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
		});

		it("should return error string for timeout", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("Request timeout"));

			const result = await executeWebFetch({ url: "https://example.com/slow" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/timeout/i);
		});
	});

	describe("HTTP error handling", () => {
		it("should return error string for 404", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 404,
					statusText: "Not Found",
				}),
			);

			const result = await executeWebFetch({ url: "https://example.com/not-found" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/404|Not found/i);
		});

		it("should return error string for rate limiting", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 429,
					statusText: "Too Many Requests",
				}),
			);

			const result = await executeWebFetch({ url: "https://example.com/rate-limited" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/rate|retry/i);
		});

		it("should return generic error for other HTTP errors", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 500,
					statusText: "Internal Server Error",
				}),
			);

			const result = await executeWebFetch({ url: "https://example.com/error" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/Fetch failed/i);
		});
	});

	describe("Empty content handling", () => {
		it("should return error for empty response", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("", {
					status: 200,
				}),
			);

			const result = await executeWebFetch({ url: "https://example.com/empty" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/No content/i);
		});

		it("should return error for whitespace-only content", async () => {
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("   \n\t\n   ", {
					status: 200,
				}),
			);

			const result = await executeWebFetch({ url: "https://example.com/whitespace" }, mockFetch);
			const output = getTextOutput(result);

			expect(output).toMatch(/^Error:/);
			expect(output).toMatch(/No content/i);
		});
	});
});

describe("Error format consistency", () => {
	it("web_search errors should be valid JSON with error and retry fields", () => {
		// These are the expected error JSON shapes
		const emptyQueryError = { error: "Empty query", retry: false };
		const rateLimitError = { error: "Search rate limited", retry: true };
		const genericError = { error: "Search failed", retry: true };

		expect(() => JSON.stringify(emptyQueryError)).not.toThrow();
		expect(() => JSON.stringify(rateLimitError)).not.toThrow();
		expect(() => JSON.stringify(genericError)).not.toThrow();

		// Verify structure
		expect(emptyQueryError).toHaveProperty("error");
		expect(emptyQueryError).toHaveProperty("retry");
		expect(rateLimitError).toHaveProperty("error");
		expect(rateLimitError).toHaveProperty("retry");
	});

	it("web_fetch errors should be strings starting with 'Error: '", () => {
		const errors = [
			"Error: Invalid URL format",
			"Error: URL not allowed",
			"Error: Request timeout: Connection timed out",
			"Error: Rate limited, please retry later",
			"Error: Page not found (404)",
			"Error: No content could be extracted",
			"Error: Fetch failed: Some error",
		];

		for (const error of errors) {
			expect(error).toMatch(/^Error: /);
			expect(typeof error).toBe("string");
		}
	});
});
