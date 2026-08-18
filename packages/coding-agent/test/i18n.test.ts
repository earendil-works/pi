import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocale, initI18n, isCJK, resetI18n, t } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isValidLocale, SUPPORTED_LOCALE_VALUES, SUPPORTED_LOCALES } from "../src/core/supported-locales.ts";

const localeDir = join(dirname(fileURLToPath(new URL("../../tui/src/i18n/index.ts", import.meta.url))), "locales");

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
		test("returns translation for existing key", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.cli.usage")).toBe("Usage:");
		});

		test("returns key for missing key", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("nonexistent.key")).toBe("nonexistent.key");
		});

		test("handles nested keys", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.generic.error")).toBe("Error");
		});
	});

	describe("t() - interpolation", () => {
		test("interpolates variables", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.fileNotFound", { path: "/test/file.ts" });
			expect(result).toBe("File not found: /test/file.ts");
		});

		test("leaves missing variables as placeholders", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.generic.fileNotFound", {});
			expect(result).toBe("File not found: {{path}}");
		});
	});

	describe("t() - fallback chain", () => {
		test("uses Chinese for zh-CN locale", () => {
			initI18n({ locale: "zh-CN", localeDir });
			expect(t("codingAgent.cli.usage")).toBe("用法：");
		});

		test("uses English when locale is en", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.cli.usage")).toBe("Usage:");
		});
	});

	describe("t() - plural support", () => {
		test("uses _other form for count !== 1", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("nonexistent", { count: 5 });
			expect(result).toBe("nonexistent");
		});
	});

	describe("getLocale()", () => {
		test("returns current locale", () => {
			initI18n({ locale: "en", localeDir });
			expect(getLocale()).toBe("en");
		});

		test("returns zh-CN when set", () => {
			initI18n({ locale: "zh-CN", localeDir });
			expect(getLocale()).toBe("zh-CN");
		});
	});

	describe("isCJK()", () => {
		test("returns true for zh-CN", () => {
			initI18n({ locale: "zh-CN", localeDir });
			expect(isCJK()).toBe(true);
		});

		test("returns false for en", () => {
			initI18n({ locale: "en", localeDir });
			expect(isCJK()).toBe(false);
		});
	});

	describe("locale detection", () => {
		test("uses PI_LOCALE env var", () => {
			process.env.PI_LOCALE = "zh-CN";
			initI18n({ localeDir });
			expect(getLocale()).toBe("zh-CN");
		});

		test("falls back to en for unsupported locale", () => {
			initI18n({ locale: "en", localeDir });
			expect(getLocale()).toBe("en");
		});
	});

	describe("新增翻译键验证", () => {
		test("clipboard error messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.clipboard.failedToCopy")).toBe("Failed to copy to clipboard");
		});

		test("export error messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.export.cannotExportInMemory")).toBe("Cannot export in-memory session to HTML");
			expect(t("codingAgent.errors.export.nothingToExport")).toBe(
				"Nothing to export yet - start a conversation first",
			);
		});

		test("settings error messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.settings.projectNotTrustedStorage")).toBe(
				"Project is not trusted; refusing to write project settings",
			);
		});

		test("tools error messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.tools.invalidTimeout")).toBe(
				"Invalid timeout: must be a finite number of seconds",
			);
			expect(t("codingAgent.errors.tools.editInvalidInput")).toBe(
				"Edit tool input is invalid. edits must contain at least one replacement.",
			);
			expect(t("codingAgent.errors.tools.editDiffRangeOutside")).toBe(
				"Replacement range is outside the base content.",
			);
			expect(t("codingAgent.errors.tools.editDiffPreserveFailed")).toBe(
				"Cannot preserve unchanged lines because the base content has a different line count.",
			);
		});

		test("package error messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.errors.package.projectNotTrustedStorage")).toBe(
				"Project is not trusted; refusing to access project package storage",
			);
		});

		test("config selfUpdate messages", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.config.selfUpdate.downloadFrom")).toBe(
				"Download from: https://github.com/earendil-works/pi-mono/releases/latest",
			);
			expect(t("codingAgent.config.selfUpdate.runCommand", { command: "npm update pi" })).toBe("Run: npm update pi");
		});

		test("config selfUpdate messages with interpolation", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.config.selfUpdate.managedNotWritable", {
				method: "npm",
				command: "npm install -g @earendil-works/pi-coding-agent",
			});
			expect(result).toContain("npm");
			expect(result).toContain("npm install -g @earendil-works/pi-coding-agent");
		});

		test("Chinese translations exist", () => {
			initI18n({ locale: "zh-CN", localeDir });
			expect(t("codingAgent.errors.clipboard.failedToCopy")).toBe("复制到剪贴板失败");
			expect(t("codingAgent.errors.export.cannotExportInMemory")).toBe("无法将内存中的会话导出为 HTML");
			expect(t("codingAgent.errors.tools.invalidTimeout")).toBe("无效的超时：必须是有限的秒数");
		});
	});

	describe("边界条件测试", () => {
		test("handles missing translation keys gracefully", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("nonexistent.key.that.does.not.exist");
			expect(result).toBe("nonexistent.key.that.does.not.exist");
		});

		test("handles empty interpolation parameters", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.config.selfUpdate.managedNotWritable", {});
			expect(result).toContain("{{method}}");
			expect(result).toContain("{{command}}");
		});

		test("handles partial interpolation parameters", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.config.selfUpdate.managedNotWritable", { method: "npm" });
			expect(result).toContain("npm");
			expect(result).toContain("{{command}}");
		});

		test("handles extra interpolation parameters", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.clipboard.failedToCopy", { extra: "param" });
			expect(result).toBe("Failed to copy to clipboard");
		});

		test("handles numeric interpolation parameters", () => {
			initI18n({ locale: "en", localeDir });
			const result = t("codingAgent.errors.tools.invalidTimeout", { timeout: 30 });
			expect(result).toBe("Invalid timeout: must be a finite number of seconds");
		});
	});

	describe("supported-locales", () => {
		test("isValidLocale accepts supported locales", () => {
			expect(isValidLocale("en")).toBe(true);
			expect(isValidLocale("zh-CN")).toBe(true);
		});

		test("isValidLocale rejects unsupported locales", () => {
			expect(isValidLocale("fr")).toBe(false);
			expect(isValidLocale("ja")).toBe(false);
			expect(isValidLocale("")).toBe(false);
			expect(isValidLocale("EN")).toBe(false);
			expect(isValidLocale("zh_CN")).toBe(false);
		});

		test("SUPPORTED_LOCALES has expected structure", () => {
			expect(SUPPORTED_LOCALES).toHaveLength(2);
			expect(SUPPORTED_LOCALES[0]).toEqual({ value: "en", label: "English" });
			expect(SUPPORTED_LOCALES[1]).toEqual({ value: "zh-CN", label: "简体中文" });
		});

		test("SUPPORTED_LOCALE_VALUES matches SUPPORTED_LOCALES", () => {
			expect(SUPPORTED_LOCALE_VALUES).toHaveLength(2);
			expect(SUPPORTED_LOCALE_VALUES).toContain("en");
			expect(SUPPORTED_LOCALE_VALUES).toContain("zh-CN");
		});
	});

	describe("语言设置翻译键", () => {
		test("settings locale keys exist in English", () => {
			initI18n({ locale: "en", localeDir });
			expect(t("codingAgent.ui.settings.locale")).toBe("Language");
			expect(t("codingAgent.ui.settings.localeDesc")).toBe("UI display language");
			expect(t("codingAgent.ui.settings.language.title")).toBe("Language");
			expect(t("codingAgent.ui.settings.language.selectDesc")).toBe("Select the UI display language");
		});

		test("settings locale keys exist in Chinese", () => {
			initI18n({ locale: "zh-CN", localeDir });
			expect(t("codingAgent.ui.settings.locale")).toBe("语言");
			expect(t("codingAgent.ui.settings.localeDesc")).toBe("界面显示语言");
			expect(t("codingAgent.ui.settings.language.title")).toBe("语言");
			expect(t("codingAgent.ui.settings.language.selectDesc")).toBe("选择界面显示语言");
		});
	});
});
