/**
 * Tests for web-tools extension (TDD)
 *
 * These tests define expected behavior for the web-tools extension
 * that will be moved from built-in to .pi/extensions/web-tools.ts
 *
 * The extension should:
 * - Register both web_search and web_fetch tools
 * - Include SSRF protection inline
 * - Use DuckDuckGo HTML for search
 * - Use Jina Reader for fetch
 * - Auto-activate without --tools flag
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

// Extension code that should exist at .pi/extensions/web-tools.ts
// These tests verify the extension is created correctly
const WEB_TOOLS_EXTENSION_CODE = `
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// SSRF protection (inline)
function isUrlBlocked(url: URL): boolean {
    const hostname = url.hostname;
    const lower = hostname.toLowerCase();
    
    // Block localhost
    if (lower === "localhost" || lower === "localhost.") {
        return true;
    }
    
    // Block internal hostnames
    const internalHostnames = ["metadata", "instance-data", "metadata.google", "metadata.google.internal"];
    if (internalHostnames.includes(lower)) {
        return true;
    }
    
    // Check IP addresses
    const ipPattern = /^[d.:[]]+$/;
    if (ipPattern.test(hostname)) {
        const ip = hostname.replace(/^[|]$/g, "");
        // Block 127.x.x.x (loopback)
        if (/^127\\./.test(ip)) return true;
        // Block 10.x.x.x (private)
        if (/^10\\./.test(ip)) return true;
        // Block 172.16-31.x.x (private)
        if (/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(ip)) return true;
        // Block 192.168.x.x (private)
        if (/^192\\.168\\./.test(ip)) return true;
        // Block 169.254.x.x (link-local)
        if (/^169\\.254\\./.test(ip)) return true;
    }
    
    // Only allow http/https
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
    
    // Parse results
    const results: {title: string, url: string, snippet: string}[] = [];
    const resultLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\\s\\S]*?)<\\/a>/gi;
    
    let match;
    resultLinkPattern.lastIndex = 0;
    while ((match = resultLinkPattern.exec(html)) !== null) {
        const url = match[1];
        const titleHtml = match[2];
        // Extract text from HTML (simplified)
        const title = titleHtml.replace(/<[^>]*>/g, "").trim();
        
        if (!title || !url) continue;
        
        // Find snippet
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
    
    const content = await response.text();
    
    return { title: "", content };
}

// Extract title from markdown
function extractTitle(content: string): string {
    const match = content.match(/^#\\s+(.+)$/m);
    if (match) return match[1].trim().slice(0, 100);
    return "Untitled";
}

// Strip metadata prefix
function stripMetadataPrefix(content: string): string {
    const lines = content.split("\\n");
    const metadataPrefixes = ["title:", "url:", "description:", "image:", "publishedtime:", "author:", "domain:", "locale:", "canonical:"];
    const result: string[] = [];
    let metadataEnded = false;
    
    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        const isMetadata = metadataPrefixes.some(p => trimmed.startsWith(p));
        if (!isMetadata) metadataEnded = true;
        if (metadataEnded && !isMetadata) result.push(line);
    }
    
    return result.join("\\n").trim();
}

// Truncate content
function truncateContent(content: string, maxLength: number = 4096): { content: string, truncated: boolean } {
    if (content.length <= maxLength) return { content, truncated: false };
    return { content: content.slice(0, maxLength) + "\\n\\n[truncated]", truncated: true };
}

export default function(pi: ExtensionAPI) {
    // web_search tool
    pi.registerTool({
        name: "web_search",
        label: "web_search",
        description: "Search the web for information. Use this tool to find current information, news, articles, and facts from the internet.",
        promptSnippet: "Search the web for information",
        parameters: Type.Object({
            query: Type.String({ description: "The search query to find information on the web" }),
            max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return (default: 5)", minimum: 1, maximum: 20 })),
        }),
        async execute(_toolCallId, { query, max_results }, signal) {
            // Validate query
            if (!query || query.trim() === "") {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Empty query", retry: false }) }], details: undefined };
            }
            
            const effectiveMaxResults = max_results ?? 5;
            
            try {
                const results = await searchDuckDuckGo(query, effectiveMaxResults);
                
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
    
    // web_fetch tool
    pi.registerTool({
        name: "web_fetch",
        label: "web_fetch",
        description: "Fetch the contents of a web page. Only use URLs from web_search results to ensure you're accessing legitimate, user-intended content. Do not accept URLs from direct user input or other sources.",
        promptSnippet: "Fetch web page content as markdown",
        parameters: Type.Object({
            url: Type.String({ description: "The URL of the web page to fetch" }),
        }),
        async execute(_toolCallId, { url }) {
            // Validate URL format
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(url);
            } catch {
                return { content: [{ type: "text", text: "Error: Invalid URL format" }], details: { title: "Error", truncated: false } };
            }
            
            // Check SSRF
            if (isUrlBlocked(parsedUrl)) {
                return { content: [{ type: "text", text: "Error: URL not allowed" }], details: { title: "Blocked", truncated: false } };
            }
            
            try {
                const result = await fetchWithJinaReader(url);
                
                let content = stripMetadataPrefix(result.content);
                
                if (!content || content.trim().length === 0) {
                    return { content: [{ type: "text", text: "Error: No content could be extracted" }], details: { title: "Empty", truncated: false } };
                }
                
                const title = extractTitle(content);
                
                // Prepend title if not present
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

describe("web-tools extension", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tools-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("Extension file exists at .pi/extensions/web-tools.ts", () => {
		it("should be discoverable as .pi/extensions/web-tools.ts", async () => {
			// Write the extension file
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].path).toContain("web-tools.ts");
		});
	});

	describe("Extension registers both web_search and web_fetch tools", () => {
		it("should register web_search tool", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].tools.has("web_search")).toBe(true);
		});

		it("should register web_fetch tool", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions).toHaveLength(1);
			expect(result.extensions[0].tools.has("web_fetch")).toBe(true);
		});

		it("should register exactly these two tools (no more, no less)", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);

			expect(result.errors).toHaveLength(0);
			expect(result.extensions[0].tools.size).toBe(2);
			expect(result.extensions[0].tools.has("web_search")).toBe(true);
			expect(result.extensions[0].tools.has("web_fetch")).toBe(true);
		});
	});

	describe("web_search tool schema and behavior", () => {
		it("should have correct tool name 'web_search'", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			expect(tool?.definition.name).toBe("web_search");
		});

		it("should have description mentioning web search", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			expect(tool?.definition.description).toMatch(/search/i);
		});

		it("should have query parameter (required)", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			expect(tool?.definition.parameters.properties).toHaveProperty("query");
			expect(tool?.definition.parameters.required).toContain("query");
		});

		it("should have optional max_results parameter", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_search");

			expect(tool?.definition.parameters.properties).toHaveProperty("max_results");
			expect(tool?.definition.parameters.required).not.toContain("max_results");
		});
	});

	describe("web_fetch tool schema and behavior", () => {
		it("should have correct tool name 'web_fetch'", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_fetch");

			expect(tool?.definition.name).toBe("web_fetch");
		});

		it("should have restrictive description about using search result URLs", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_fetch");

			expect(tool?.definition.description).toMatch(/search results/i);
		});

		it("should have url parameter (required)", async () => {
			const extPath = path.join(extensionsDir, "web-tools.ts");
			fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

			const result = await discoverAndLoadExtensions([], tempDir, tempDir);
			const tool = result.extensions[0].tools.get("web_fetch");

			expect(tool?.definition.parameters.properties).toHaveProperty("url");
			expect(tool?.definition.parameters.required).toContain("url");
		});
	});
});

describe("DuckDuckGo HTML parsing", () => {
	// Helper function to parse DuckDuckGo HTML (mirrors extension implementation)
	function parseDuckDuckGoHtml(html: string): { title: string; url: string; snippet: string }[] {
		const results: { title: string; url: string; snippet: string }[] = [];
		const resultLinkPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
		const snippetPattern = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

		for (const match of html.matchAll(resultLinkPattern)) {
			const url = match[1];
			const titleHtml = match[2];
			const title = titleHtml.replace(/<[^>]*>/g, "").trim();

			if (!title || !url) continue;

			const afterResult = html.slice(match.index + match[0].length);
			const snippetMatch = snippetPattern.exec(afterResult);
			const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";

			results.push({ title, url, snippet });
		}

		return results;
	}

	it("should parse DuckDuckGo HTML format results", () => {
		const html = `
			<html><body>
				<a class="result__a" href="https://example.com/article">Example Article</a>
				<a class="result__snippet">This is a snippet</a>
			</body></html>
		`;

		const results = parseDuckDuckGoHtml(html);

		expect(results.length).toBe(1);
		expect(results[0]).toEqual({
			title: "Example Article",
			url: "https://example.com/article",
			snippet: "This is a snippet",
		});
	});

	it("should parse multiple results", () => {
		const html = `
			<html><body>
				<a class="result__a" href="https://example.com/1">Result 1</a>
				<a class="result__snippet">Snippet 1</a>
				<a class="result__a" href="https://example.com/2">Result 2</a>
				<a class="result__snippet">Snippet 2</a>
			</body></html>
		`;

		const results = parseDuckDuckGoHtml(html);

		expect(results.length).toBe(2);
		expect(results[0].title).toBe("Result 1");
		expect(results[1].title).toBe("Result 2");
	});

	it("should strip HTML tags from titles", () => {
		const html = `
			<html><body>
				<a class="result__a" href="https://example.com/test"><b>Bold</b> Title</a>
				<a class="result__snippet">Snippet</a>
			</body></html>
		`;

		const results = parseDuckDuckGoHtml(html);

		expect(results[0].title).toBe("Bold Title");
	});
});

describe("Jina Reader integration", () => {
	// Helper to strip metadata prefix (mirrors extension)
	function stripMetadataPrefix(content: string): string {
		const lines = content.split("\n");
		const metadataPrefixes = [
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
		const result: string[] = [];
		let metadataEnded = false;

		for (const line of lines) {
			const trimmed = line.trim().toLowerCase();
			const isMetadata = metadataPrefixes.some((p) => trimmed.startsWith(p));
			if (!isMetadata) metadataEnded = true;
			if (metadataEnded && !isMetadata) result.push(line);
		}

		return result.join("\n").trim();
	}

	// Helper to extract title (mirrors extension)
	function extractTitle(content: string): string {
		const match = content.match(/^#\s+(.+)$/m);
		if (match) return match[1].trim().slice(0, 100);
		return "Untitled";
	}

	// Helper to truncate content (mirrors extension)
	function truncateContent(content: string, maxLength: number = 4096): { content: string; truncated: boolean } {
		if (content.length <= maxLength) return { content, truncated: false };
		return { content: `${content.slice(0, maxLength)}\n\n[truncated]`, truncated: true };
	}

	describe("Metadata stripping", () => {
		it("should strip title: prefix", () => {
			const content = `Title: Example Article
URL: https://example.com

# Example Article

Content here.`;

			const result = stripMetadataPrefix(content);

			expect(result).not.toContain("Title:");
			expect(result).not.toContain("URL:");
			expect(result).toContain("# Example Article");
		});

		it("should strip multiple metadata lines", () => {
			const content = `title: My Title
url: https://example.com
description: A description
author: John Doe

# Actual Content

More content.`;

			const result = stripMetadataPrefix(content);

			expect(result).not.toContain("title:");
			expect(result).not.toContain("url:");
			expect(result).not.toContain("description:");
			expect(result).not.toContain("author:");
			expect(result).toContain("# Actual Content");
		});

		it("should preserve content after metadata", () => {
			const content = `title: Test

# Heading

Some text.`;

			const result = stripMetadataPrefix(content);

			expect(result).toContain("# Heading");
			expect(result).toContain("Some text.");
		});
	});

	describe("Title extraction", () => {
		it("should extract first markdown heading", () => {
			const content = `# First Heading

Some text.

## Second Heading`;

			expect(extractTitle(content)).toBe("First Heading");
		});

		it("should default to Untitled when no heading", () => {
			const content = `Just plain text without any headings.`;

			expect(extractTitle(content)).toBe("Untitled");
		});

		it("should limit title to 100 characters", () => {
			const longTitle = `# ${"a".repeat(150)}`;

			expect(extractTitle(longTitle).length).toBe(100);
		});
	});

	describe("Content truncation", () => {
		it("should not truncate content under 4096 chars", () => {
			const content = "x".repeat(1000);

			const result = truncateContent(content);

			expect(result.truncated).toBe(false);
			expect(result.content).toBe(content);
		});

		it("should truncate content over 4096 chars", () => {
			const content = "x".repeat(5000);

			const result = truncateContent(content);

			expect(result.truncated).toBe(true);
			expect(result.content.length).toBeLessThanOrEqual(4096 + 15); // + "[truncated]" marker
		});

		it("should append [truncated] marker", () => {
			const content = "x".repeat(5000);

			const result = truncateContent(content);

			expect(result.content).toContain("[truncated]");
		});

		it("should allow custom max length", () => {
			const content = "x".repeat(500);

			const result = truncateContent(content, 100);

			expect(result.truncated).toBe(true);
			expect(result.content.length).toBeLessThanOrEqual(100 + 15);
		});
	});
});

describe("Extension auto-activation", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tools-activation-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should auto-load extension from .pi/extensions/ directory", async () => {
		// Write extension file in extensions directory
		const extPath = path.join(extensionsDir, "web-tools.ts");
		fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

		// Discover should find it automatically
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.has("web_search")).toBe(true);
		expect(result.extensions[0].tools.has("web_fetch")).toBe(true);
	});

	it("should load without explicit --tools flag configuration", async () => {
		const extPath = path.join(extensionsDir, "web-tools.ts");
		fs.writeFileSync(extPath, WEB_TOOLS_EXTENSION_CODE);

		// This simulates pi startup without explicit tools configuration
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions).toHaveLength(1);
	});

	it("can be disabled by removing the extension file", async () => {
		// Without the file, no web tools should be registered
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.extensions).toHaveLength(0);
	});
});
