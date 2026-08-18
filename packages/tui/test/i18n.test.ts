import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	formatDate,
	formatNumber,
	formatRelativeTime,
	getLocale,
	initI18n,
	isCJK,
	onLocaleChange,
	resetI18n,
	setLocale,
	t,
} from "../src/i18n/index.ts";

const localeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "i18n", "locales");

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
	const keys: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "object" && value !== null) {
			keys.push(...flattenKeys(value as Record<string, unknown>, fullKey));
		} else {
			keys.push(fullKey);
		}
	}
	return keys;
}

describe("i18n", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		resetI18n();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("t() - basic translation", () => {
		it("returns translation for existing key", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("codingAgent.cli.usage"), "Usage:");
		});

		it("returns key for missing key", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("nonexistent.key"), "nonexistent.key");
		});

		it("handles nested keys", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("codingAgent.errors.generic.error"), "Error");
		});
	});

	describe("t() - interpolation", () => {
		it("interpolates variables", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.fileNotFound", { path: "/test/file.ts" });
			assert.strictEqual(result, "File not found: /test/file.ts");
		});

		it("leaves missing variables as placeholders", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.fileNotFound", {});
			assert.strictEqual(result, "File not found: {{path}}");
		});
	});

	describe("t() - fallback chain", () => {
		it("uses Chinese for zh-CN locale", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(t("codingAgent.cli.usage"), "用法：");
		});

		it("uses English when locale is en", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("codingAgent.cli.usage"), "Usage:");
		});
	});

	describe("t() - plural support", () => {
		it("uses _other form for count !== 1", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.abortedAfterRetries", { count: 5 });
			assert.strictEqual(result, "Aborted after 5 retry attempt(s)");
		});

		it("uses _other form for count === 1 (no _one suffix defined)", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.abortedAfterRetries", { count: 1 });
			assert.strictEqual(result, "Aborted after 1 retry attempt(s)");
		});
	});

	describe("getLocale()", () => {
		it("returns current locale", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(getLocale(), "en");
		});

		it("returns zh-CN when set", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(getLocale(), "zh-CN");
		});
	});

	describe("isCJK()", () => {
		it("returns true for zh-CN", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(isCJK(), true);
		});

		it("returns false for en", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(isCJK(), false);
		});
	});

	describe("locale detection", () => {
		it("uses PI_LOCALE env var", () => {
			process.env.PI_LOCALE = "zh-CN";
			initI18n({ localeDir });
			assert.strictEqual(getLocale(), "zh-CN");
		});

		it("falls back to en for unsupported locale", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(getLocale(), "en");
		});
	});

	describe("new i18n keys", () => {
		it("translates altScreen.findTranscript", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("altScreen.findTranscript"), "Find transcript");
		});

		it("translates altScreen.findTranscript for zh-CN", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(t("altScreen.findTranscript"), "查找转录");
		});

		it("translates codingAgent.errors.generic.operationAborted", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("codingAgent.errors.generic.operationAborted"), "Operation aborted");
		});

		it("translates codingAgent.errors.generic.operationAborted for zh-CN", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(t("codingAgent.errors.generic.operationAborted"), "操作已中止");
		});
	});

	describe("translation coverage", () => {
		it("all en.json keys are translatable", () => {
			const enPath = join(localeDir, "en.json");
			const enContent = readFileSync(enPath, "utf-8");
			const enData = JSON.parse(enContent);
			const allKeys = flattenKeys(enData);

			initI18n({ locale: "en", localeDir });

			const missingKeys: string[] = [];
			for (const key of allKeys) {
				// Skip keys that use dot notation in their name (like keybindings.tui.editor.cursorUp)
				// These are stored as flat keys in the JSON but accessed differently
				if (key.startsWith("keybindings.") || key.startsWith("ui.hotkeys.")) {
					continue;
				}
				const result = t(key);
				if (result === key) {
					missingKeys.push(key);
				}
			}

			assert.strictEqual(
				missingKeys.length,
				0,
				`The following keys are defined in en.json but return the key itself when translated: ${missingKeys.join(", ")}`,
			);
		});

		it("all zh-CN.json keys are translatable", () => {
			const zhCNPath = join(localeDir, "zh-CN.json");
			const zhCNContent = readFileSync(zhCNPath, "utf-8");
			const zhCNData = JSON.parse(zhCNContent);
			const allKeys = flattenKeys(zhCNData);

			initI18n({ locale: "zh-CN", localeDir });

			const missingKeys: string[] = [];
			for (const key of allKeys) {
				// Skip keys that use dot notation in their name (like keybindings.tui.editor.cursorUp)
				// These are stored as flat keys in the JSON but accessed differently
				if (key.startsWith("keybindings.") || key.startsWith("ui.hotkeys.")) {
					continue;
				}
				const result = t(key);
				if (result === key) {
					missingKeys.push(key);
				}
			}

			assert.strictEqual(
				missingKeys.length,
				0,
				`The following keys are defined in zh-CN.json but return the key itself when translated: ${missingKeys.join(", ")}`,
			);
		});

		it("en.json and zh-CN.json have identical key structures", () => {
			const enPath = join(localeDir, "en.json");
			const zhCNPath = join(localeDir, "zh-CN.json");
			const enData = JSON.parse(readFileSync(enPath, "utf-8"));
			const zhCNData = JSON.parse(readFileSync(zhCNPath, "utf-8"));
			const enKeys = flattenKeys(enData).sort();
			const zhCNKeys = flattenKeys(zhCNData).sort();

			const missingInZhCN = enKeys.filter((k) => !zhCNKeys.includes(k));
			const missingInEn = zhCNKeys.filter((k) => !enKeys.includes(k));

			assert.strictEqual(
				missingInZhCN.length,
				0,
				`Keys in en.json missing from zh-CN.json: ${missingInZhCN.join(", ")}`,
			);
			assert.strictEqual(
				missingInEn.length,
				0,
				`Keys in zh-CN.json missing from en.json: ${missingInEn.join(", ")}`,
			);
		});
	});

	describe("setLocale() - runtime switching", () => {
		it("switches locale at runtime", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(getLocale(), "en");
			assert.strictEqual(t("codingAgent.cli.usage"), "Usage:");

			setLocale("zh-CN", localeDir);
			assert.strictEqual(getLocale(), "zh-CN");
			assert.strictEqual(t("codingAgent.cli.usage"), "用法：");
		});

		it("notifies listeners on locale change", () => {
			initI18n({ locale: "en", localeDir });
			let notifiedLocale: string | undefined;
			const unsub = onLocaleChange((locale) => {
				notifiedLocale = locale;
			});

			setLocale("zh-CN", localeDir);
			assert.strictEqual(notifiedLocale, "zh-CN");

			unsub();
		});

		it("does not notify after unsubscribe", () => {
			initI18n({ locale: "en", localeDir });
			let called = false;
			const unsub = onLocaleChange(() => {
				called = true;
			});

			unsub();
			setLocale("zh-CN", localeDir);
			assert.strictEqual(called, false);
		});

		it("ignores unsupported locale", () => {
			initI18n({ locale: "en", localeDir });
			setLocale("fr" as never, localeDir);
			assert.strictEqual(getLocale(), "en");
		});

		it("does not reload if same locale", () => {
			initI18n({ locale: "en", localeDir });
			let called = false;
			const unsub = onLocaleChange(() => {
				called = true;
			});

			setLocale("en", localeDir);
			assert.strictEqual(called, false);

			unsub();
		});
	});

	describe("formatNumber()", () => {
		it("formats number in English", () => {
			initI18n({ locale: "en", localeDir });
			const result = formatNumber(1234567.89);
			assert.strictEqual(result, "1,234,567.89");
		});

		it("formats number in Chinese", () => {
			initI18n({ locale: "zh-CN", localeDir });
			const result = formatNumber(1234567.89);
			assert.strictEqual(result, "1,234,567.89");
		});

		it("formats currency", () => {
			initI18n({ locale: "en", localeDir });
			const result = formatNumber(42.5, { style: "currency", currency: "USD" });
			assert.strictEqual(result, "$42.50");
		});

		it("formats percentage", () => {
			initI18n({ locale: "en", localeDir });
			const result = formatNumber(0.85, { style: "percent" });
			assert.strictEqual(result, "85%");
		});
	});

	describe("formatDate()", () => {
		it("formats date in English", () => {
			initI18n({ locale: "en", localeDir });
			const date = new Date("2026-03-15T10:30:00Z");
			const result = formatDate(date, { year: "numeric", month: "long", day: "numeric" });
			assert.ok(result.includes("2026"));
			assert.ok(result.includes("15"));
		});

		it("formats date in Chinese", () => {
			initI18n({ locale: "zh-CN", localeDir });
			const date = new Date("2026-03-15T10:30:00Z");
			const result = formatDate(date, { year: "numeric", month: "long", day: "numeric" });
			assert.ok(result.includes("2026"));
			assert.ok(result.includes("15"));
		});
	});

	describe("formatRelativeTime()", () => {
		it("formats relative time in English", () => {
			initI18n({ locale: "en", localeDir });
			const result = formatRelativeTime(-3, "hour");
			assert.strictEqual(result, "3 hours ago");
		});

		it("formats relative time in Chinese", () => {
			initI18n({ locale: "zh-CN", localeDir });
			const result = formatRelativeTime(-3, "hour");
			assert.ok(result.includes("3"));
		});

		it("formats future relative time", () => {
			initI18n({ locale: "en", localeDir });
			const result = formatRelativeTime(2, "day");
			assert.strictEqual(result, "in 2 days");
		});
	});

	describe("new i18n keys", () => {
		it("translates codingAgent.cli.errors.nameRequiresValue", () => {
			initI18n({ locale: "en", localeDir });
			assert.strictEqual(t("codingAgent.cli.errors.nameRequiresValue"), "--name requires a value");
		});

		it("translates codingAgent.cli.errors.nameRequiresValue for zh-CN", () => {
			initI18n({ locale: "zh-CN", localeDir });
			assert.strictEqual(t("codingAgent.cli.errors.nameRequiresValue"), "--name 需要一个值");
		});

		it("translates codingAgent.cli.errors.invalidThinkingLevel with params", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.cli.errors.invalidThinkingLevel", {
				level: "turbo",
				validValues: "off, minimal, low, medium, high, xhigh, max",
			});
			assert.strictEqual(
				result,
				'Invalid thinking level "turbo". Valid values: off, minimal, low, medium, high, xhigh, max',
			);
		});

		it("translates codingAgent.errors.generic.extensionError", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.extensionError", {
				path: "/ext/foo",
				error: "load failed",
			});
			assert.strictEqual(result, "Extension error (/ext/foo): load failed");
		});

		it("translates codingAgent.errors.print.requestFailed", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.print.requestFailed", { reason: "error" });
			assert.strictEqual(result, "Request error");
		});
	});
});
