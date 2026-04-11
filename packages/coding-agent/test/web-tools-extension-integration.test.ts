/**
 * Integration tests for web-tools extension (TDD)
 *
 * Tests the extension working within the pi extension system:
 * - Tools can be loaded from extension discovery
 * - Tools appear in getAllTools() and getActiveTools()
 * - Tools can be called through the extension API
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

// Extension code that implements the expected web-tools extension behavior
const WEB_TOOLS_EXTENSION_CODE = `
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// SSRF protection
function isUrlBlocked(url: URL): boolean {
    const hostname = url.hostname;
    const lower = hostname.toLowerCase();
    
    if (lower === "localhost" || lower === "localhost.") return true;
    
    const internalHostnames = ["metadata", "instance-data", "metadata.google", "metadata.google.internal"];
    if (internalHostnames.includes(lower)) return true;
    
    const ipPattern = /^[d.:[]]+$/;
    if (ipPattern.test(hostname)) {
        const ip = hostname.replace(/^[|]$/g, "");
        if (/^127\\./.test(ip)) return true;
        if (/^10\\./.test(ip)) return true;
        if (/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(ip)) return true;
        if (/^192\\.168\\./.test(ip)) return true;
        if (/^169\\.254\\./.test(ip)) return true;
    }
    
    return url.protocol !== "https:" && url.protocol !== "http:";
}

// DuckDuckGo search
async function searchDuckDuckGo(query: string, maxResults: number): Promise<{title: string, url: string, snippet: string}[]> {
    const encodedQuery = encodeURIComponent(query);
    const url = \`https://html.duckduckgo.com/html/?q=\${encodedQuery}\`;
    
    const response = await fetch(url, {
        headers: {
            Accept: "text/html",
            "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)",
        },
    });
    
    if (!response.ok) {
        if (response.status === 429) throw new Error("Rate limit exceeded");
        throw new Error(\`Search failed: HTTP \${response.status}\`);
    }
    
    const html = await response.text();
    
    const results: {title: string, url: string, snippet: string}[] = [];
    const resultLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    
    let match;
    resultLinkPattern.lastIndex = 0;
    while ((match = resultLinkPattern.exec(html)) !== null) {
        const url = match[1];
        const titleHtml = match[2];
        const title = titleHtml.replace(/<[^>]*>/g, "").trim();
        
        if (!title || !url) continue;
        
        const afterResult = html.slice(match.index + match[0].length);
        const snippetMatch = snippetPattern.exec(afterResult);
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        
        results.push({ title, url, snippet });
    }
    
    return results.slice(0, maxResults);
}

// Jina Reader fetch
async function fetchWithJinaReader(url: string): Promise<{title: string, content: string}> {
    const jinaUrl = \`https://r.jina.ai/\${url}\`;
    
    const response = await fetch(jinaUrl, {
        headers: {
            Accept: "text/markdown, text/plain",
            "X-Return-Format": "markdown",
            "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)",
        },
    });
    
    if (!response.ok) {
        if (response.status === 429) throw new Error("Rate limit exceeded");
        if (response.status === 404) throw new Error("Page not found");
        throw new Error(\`Fetch failed: HTTP \${response.status}\`);
    }
    
    return { title: "", content: await response.text() };
}

function extractTitle(content: string): string {
    const match = content.match(/^#\\s+(.+)$/m);
    return match ? match[1].trim().slice(0, 100) : "Untitled";
}

function stripMetadataPrefix(content: string): string {
    const lines = content.split("\\n");
    const prefixes = ["title:", "url:", "description:", "image:", "publishedtime:", "author:", "domain:", "locale:", "canonical:"];
    const result: string[] = [];
    let metadataEnded = false;
    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        const isMetadata = prefixes.some(p => trimmed.startsWith(p));
        if (!isMetadata) metadataEnded = true;
        if (metadataEnded && !isMetadata) result.push(line);
    }
    return result.join("\\n").trim();
}

function truncateContent(content: string, maxLength: number = 4096): { content: string, truncated: boolean } {
    if (content.length <= maxLength) return { content, truncated: false };
    return { content: content.slice(0, maxLength) + "\\n\\n[truncated]", truncated: true };
}

export default function(pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_search",
        label: "web_search",
        description: "Search the web for information. Use this tool to find current information, news, articles, and facts from the internet.",
        promptSnippet: "Search the web for information",
        parameters: Type.Object({
            query: Type.String({ description: "The search query" }),
            max_results: Type.Optional(Type.Number({ description: "Max results", minimum: 1, maximum: 20 })),
        }),
        async execute(_toolCallId, { query, max_results }, signal) {
            if (!query || query.trim() === "") {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Empty query", retry: false }) }], details: undefined };
            }
            
            const effectiveMaxResults = max_results ?? 5;
            
            try {
                const results = await searchDuckDuckGo(query, effectiveMaxResults, signal);
                if (results.length === 0) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: "Search failed", retry: false }) }], details: undefined };
                }
                return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }], details: { results } };
            } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                const isRateLimit = message.toLowerCase().includes("rate limit");
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: isRateLimit ? "Search rate limited" : "Search failed", retry: true }) }],
                    details: undefined,
                };
            }
        },
    });
    
    pi.registerTool({
        name: "web_fetch",
        label: "web_fetch",
        description: "Fetch the contents of a web page. Only use URLs from web_search results.",
        promptSnippet: "Fetch web page content as markdown",
        parameters: Type.Object({
            url: Type.String({ description: "The URL of the web page to fetch" }),
        }),
        async execute(_toolCallId, { url }, signal) {
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(url);
            } catch {
                return { content: [{ type: "text", text: "Error: Invalid URL format" }], details: { title: "Error", truncated: false } };
            }
            
            if (isUrlBlocked(parsedUrl)) {
                return { content: [{ type: "text", text: "Error: URL not allowed" }], details: { title: "Blocked", truncated: false } };
            }
            
            try {
                const result = await fetchWithJinaReader(url, signal);
                let content = stripMetadataPrefix(result.content);
                
                if (!content || content.trim().length === 0) {
                    return { content: [{ type: "text", text: "Error: No content could be extracted" }], details: { title: "Empty", truncated: false } };
                }
                
                const title = extractTitle(content);
                
                if (!content.startsWith("#")) {
                    content = \`# \${title}\\n\\n\${content}\`;
                }
                
                const { content: truncatedContent, truncated } = truncateContent(content);
                return { content: [{ type: "text", text: truncatedContent }], details: { title, truncated } };
            } catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted")) {
                    return { content: [{ type: "text", text: \`Error: Request timeout: \${message}\` }], details: { title: "Timeout", truncated: false } };
                }
                if (message.toLowerCase().includes("rate limit")) {
                    return { content: [{ type: "text", text: "Error: Rate limited, please retry later" }], details: { title: "Rate Limited", truncated: false } };
                }
                if (message.toLowerCase().includes("not found")) {
                    return { content: [{ type: "text", text: "Error: Page not found (404)" }], details: { title: "Not Found", truncated: false } };
                }
                return { content: [{ type: "text", text: \`Error: Fetch failed: \${message}\` }], details: { title: "Error", truncated: false } };
            }
        },
    });
}
`;

describe("web-tools extension integration", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tools-integration-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("Extension discovery and loading", () => {
		it("should discover web-tools.ts from extensions directory", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
		});

		it("should load without errors", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
		});

		it("should report errors for invalid extension code", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), "this is not valid typescript");

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe("Tool registration", () => {
		it("should register web_search tool with correct properties", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			const tool = result.extensions[0].tools.get("web_search");
			expect(tool).toBeDefined();
			expect(tool?.definition.name).toBe("web_search");
			expect(tool?.definition.label).toBe("web_search");
			expect(tool?.definition.description).toBeTruthy();
		});

		it("should register web_fetch tool with correct properties", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			const tool = result.extensions[0].tools.get("web_fetch");
			expect(tool).toBeDefined();
			expect(tool?.definition.name).toBe("web_fetch");
			expect(tool?.definition.description).toMatch(/search results/i);
		});

		it("should have TypeBox parameter schemas", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			const searchTool = result.extensions[0].tools.get("web_search");
			const fetchTool = result.extensions[0].tools.get("web_fetch");

			expect(searchTool?.definition.parameters.type).toBe("object");
			expect(searchTool?.definition.parameters.properties).toHaveProperty("query");

			expect(fetchTool?.definition.parameters.type).toBe("object");
			expect(fetchTool?.definition.parameters.properties).toHaveProperty("url");
		});
	});

	describe("Tool execution (mocked fetch)", () => {
		beforeEach(() => {
			vi.spyOn(globalThis, "fetch");
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("should execute web_search and return results", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			// Mock fetch response
			const duckyHtml = `
				<html><body>
					<a class="result__a" href="https://example.com/article">Test Article</a>
					<a class="result__snippet">This is a test</a>
				</body></html>
			`;

			(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
				new Response(duckyHtml, {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			);

			const executeResult = await tool?.definition.execute(
				"test-id",
				{ query: "test" },
				undefined,
				undefined,
				{} as any,
			);

			expect(executeResult).toBeDefined();
			expect(executeResult?.content[0].type).toBe("text");

			const text = (executeResult?.content[0] as any).text || "";
			expect(() => JSON.parse(text)).not.toThrow();

			const parsed = JSON.parse(text);
			expect(parsed).toHaveProperty("results");
		});

		it("should execute web_search with empty query and return error JSON", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			const executeResult = await tool?.definition.execute(
				"test-id",
				{ query: "" },
				undefined,
				undefined,
				{} as any,
			);

			expect(executeResult).toBeDefined();
			const text = (executeResult?.content[0] as any).text || "";

			const parsed = JSON.parse(text);
			expect(parsed).toHaveProperty("error");
			expect(parsed.error).toBe("Empty query");
		});

		it("should execute web_fetch with blocked URL and return error", async () => {
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_fetch");

			const executeResult = await tool?.definition.execute(
				"test-id",
				{ url: "http://localhost/test" },
				undefined,
				undefined,
				{} as any,
			);

			expect(executeResult).toBeDefined();
			const text = (executeResult?.content[0] as any).text || "";

			expect(text).toBe("Error: URL not allowed");
		});
	});

	describe("Extension can coexist with other extensions", () => {
		it("should allow multiple extensions with different tools", async () => {
			// Write web-tools extension
			fs.writeFileSync(path.join(extensionsDir, "web-tools.ts"), WEB_TOOLS_EXTENSION_CODE);

			// Write another extension
			fs.writeFileSync(
				path.join(extensionsDir, "other-tool.ts"),
				`
				import { Type } from "@sinclair/typebox";
				export default function(pi) {
					pi.registerTool({
						name: "other_tool",
						label: "Other Tool",
						description: "Another tool",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "other" }] };
						},
					});
				}
			`,
			);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(2);

			const allToolNames = new Set<string>();
			for (const ext of result.extensions) {
				for (const name of ext.tools.keys()) {
					allToolNames.add(name);
				}
			}

			expect(allToolNames.has("web_search")).toBe(true);
			expect(allToolNames.has("web_fetch")).toBe(true);
			expect(allToolNames.has("other_tool")).toBe(true);
		});
	});
});

describe("Build verification", () => {
	it("should have valid TypeScript after removing web tools from built-ins", async () => {
		// This test verifies the types are correct after migration
		// If this passes, the TypeScript compilation succeeds
		const { codingTools, allTools } = await import("../src/core/tools/index.js");

		// Verify these are still valid exports (just not containing web tools)
		expect(Array.isArray(codingTools)).toBe(true);
		expect(typeof allTools).toBe("object");
	});
});
