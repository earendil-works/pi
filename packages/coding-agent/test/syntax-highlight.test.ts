import { resetCapabilitiesCache, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { getLanguageFromPath, highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";
import { HIGHLIGHT_LANGUAGE_LOADERS } from "../src/utils/highlight-languages.ts";
import {
	highlight,
	loadHighlightLanguage,
	onHighlightLanguageLoad,
	renderHighlightedHtml,
	requestHighlightLanguage,
	supportsLanguage,
} from "../src/utils/syntax-highlight.ts";

describe("syntax highlight renderer", () => {
	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});

	it("maps file extensions and preloads only common languages", () => {
		expect(["main.ts", "index.html", "Dockerfile", "build.ps1", "main.tf"].map(getLanguageFromPath)).toEqual([
			"typescript",
			"html",
			"dockerfile",
			"powershell",
			"hcl",
		]);
		for (const common of ["typescript", "html"]) expect(supportsLanguage(common)).toBe(true);
		for (const lazy of ["dockerfile", "powershell"]) expect(supportsLanguage(lazy)).toBe(false);
		for (const unsupported of ["fish", "graphql", "hcl", "sass"]) {
			expect(requestHighlightLanguage(unsupported)).toBeUndefined();
		}
	});

	it("loads one uncommon grammar with its aliases and dependencies", async () => {
		const loaded: string[] = [];
		const unsubscribe = onHighlightLanguageLoad((event) => {
			if (!("error" in event)) loaded.push(event.language);
		});

		expect(requestHighlightLanguage("BF")).toBeUndefined();
		expect(await loadHighlightLanguage("BF")).toBe(true);
		expect(requestHighlightLanguage("bf")).toBe("brainfuck");
		expect(supportsLanguage("abnf")).toBe(false);

		expect(await loadHighlightLanguage("php-template")).toBe(true);
		expect(supportsLanguage("php")).toBe(true);
		expect(
			highlight("<?php echo $value; ?>", {
				language: "php-template",
				theme: { keyword: (text) => `[keyword:${text}]` },
			}),
		).toContain("[keyword:echo]");
		expect(loaded).toEqual(["brainfuck", "php-template"]);
		unsubscribe();

		expect(await loadHighlightLanguage("TOML")).toBe(true);
		expect(requestHighlightLanguage("ToMl")).toBe("toml");
		expect(await loadHighlightLanguage("mojolicious")).toBe(true);
		expect(supportsLanguage("perl")).toBe(true);
		expect(await loadHighlightLanguage("ls")).toBe(true);
		expect(await loadHighlightLanguage("lasso")).toBe(true);
		expect(requestHighlightLanguage("ls")).toBe("livescript");
	});

	it("reports background load failures once without retrying", async () => {
		const originalLoad = HIGHLIGHT_LANGUAGE_LOADERS.accesslog;
		if (!originalLoad) throw new Error("accesslog test grammar is missing");
		const loadError = new Error("test grammar load failed");
		let attempts = 0;
		HIGHLIGHT_LANGUAGE_LOADERS.accesslog = () => {
			attempts++;
			return Promise.reject(loadError);
		};
		let resolveFailure: (failure: { language: string; error: unknown }) => void = () => {};
		const failure = new Promise<{ language: string; error: unknown }>((resolve) => {
			resolveFailure = resolve;
		});
		const unsubscribe = onHighlightLanguageLoad((event) => {
			if ("error" in event) resolveFailure({ language: event.language, error: event.error });
		});

		try {
			expect(requestHighlightLanguage("AccessLog")).toBeUndefined();
			await expect(failure).resolves.toEqual({ language: "accesslog", error: loadError });
			expect(requestHighlightLanguage("accesslog")).toBeUndefined();
			await Promise.resolve();
			await Promise.resolve();
			expect(attempts).toBe(1);
			await expect(loadHighlightLanguage("accesslog")).rejects.toThrow("test grammar load failed");
		} finally {
			HIGHLIGHT_LANGUAGE_LOADERS.accesslog = originalLoad;
			unsubscribe();
		}
	});
});

describe("highlight language load lifecycle", () => {
	it("refreshes the TUI when a grammar loads", async () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const unsubscribeTerminalTheme = vi.fn();
		const ui = {
			invalidate,
			requestRender,
			onTerminalColorSchemeChange: () => unsubscribeTerminalTheme,
		} as unknown as TUI;
		const settingsManager = { getThemeSetting: () => "dark" } as unknown as SettingsManager;
		const controller = new InteractiveThemeController(ui, settingsManager, vi.fn(), vi.fn());

		highlightCode("let value = 1", "arcade");
		await loadHighlightLanguage("arcade");
		expect(invalidate).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledOnce();

		invalidate.mockClear();
		requestRender.mockClear();
		controller.dispose();
		await loadHighlightLanguage("apache");
		expect(unsubscribeTerminalTheme).toHaveBeenCalledOnce();
		expect(invalidate).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
});

describe("theme syntax highlighting", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("colors diff additions and deletions in fenced diff blocks", () => {
		const lines = highlightCode("-old\n+new\n", "diff");

		expect(lines[0]).toBe("\x1b[38;2;204;102;102m-old\x1b[39m");
		expect(lines[1]).toBe("\x1b[38;2;181;189;104m+new\x1b[39m");
	});

	it("keeps cli-highlight default styled scopes mapped to theme styles", () => {
		expect(highlightCode("const re = /foo+/gi;", "javascript")[0]).toContain(
			"\x1b[38;2;206;145;120m/foo+/gi\x1b[39m",
		);
		expect(highlightCode("@decorator", "python")[0]).toBe("\x1b[38;2;128;128;128m@decorator\x1b[39m");
		expect(highlightCode("<div></div>", "html")[0]).toContain("\x1b[38;2;86;156;214mdiv\x1b[39m");
	});
});
