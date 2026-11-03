// Copied from coding-agent src/modes/interactive/theme/theme-schema.ts (p2-tui-port.md section 5.3), its schema
// rebuilt with pi-schema with the same JSON (coding-agent's copy still uses TypeBox).
/**
 * Theme JSON validation, kept out of `theme.ts` on purpose.
 *
 * Validating user-authored theme files needs a schema validator and its module graph.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * `main.ts` installs this validator before runtime resource loading; other consumers can opt in with
 * `setThemeJsonValidator()`. Built-in themes do not need validation.
 */

import { compile, int, obj, opt, type Properties, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, record, unsafe } from "../../runtime/schema.ts";
import { THEME_TOKENS, type ThemeColorValues, type ThemeTokenDescriptors } from "./theme-tokens.ts";

function colorValue(description?: string) {
	return union(
		[
			str({
				description:
					"Hex color (#RGB or #RRGGBB), OKLCH or OKHSL color, variable reference, or empty string for terminal default",
			}),
			int({
				minimum: 0,
				maximum: 255,
				description: "256-color palette index (0-255)",
			}),
		],
		description ? { description } : {},
	);
}

export const ColorValueSchema = colorValue();

export type ThemeColorValue = Static<typeof ColorValueSchema>;

function themeTokenProperties(tokens: ThemeTokenDescriptors): Properties {
	const properties: Record<string, Properties[string]> = {};
	for (const [name, descriptor] of Object.entries(tokens)) {
		const schema = colorValue(descriptor.description);
		properties[name] = descriptor.fallback === undefined ? schema : opt(schema);
	}
	return properties;
}

const ThemeColorsSchema = unsafe<ThemeColorValues<ThemeColorValue>>(
	obj(themeTokenProperties(THEME_TOKENS), {
		description:
			"Theme color definitions (scrollbar, thinkingMax, and search highlight colors are optional and use compatible fallbacks)",
	}),
);

export const ThemeJsonSchema = obj(
	{
		$schema: opt(str({ description: "JSON schema reference" })),
		name: str({
			pattern: "^[^/]+$",
			description:
				"Theme name. Must not contain '/' because it is reserved for automatic light/dark theme settings.",
		}),
		appearance: opt(
			union([literal("dark"), literal("light")], {
				description: "Background the theme is designed for. Detected from the theme colors when omitted.",
			}),
		),
		vars: opt(
			record(ColorValueSchema, {
				description: "Reusable color variables",
			}),
		),
		colors: ThemeColorsSchema,
		export: opt(
			obj(
				{
					pageBg: opt(colorValue("Page background color")),
					cardBg: opt(colorValue("Card/container background color")),
					infoBg: opt(colorValue("Info sections background (system prompt, notices)")),
				},
				{ description: "Optional colors for HTML export (defaults derived from userMessageBg if not specified)" },
			),
		),
	},
	{ title: "Pi Coding Agent Theme", description: "Theme schema for Pi coding agent" },
);

const compiledThemeSchema = compile(ThemeJsonSchema);

export type ValidatedThemeJson = Static<typeof ThemeJsonSchema>;

/** Validate one theme document, throwing a message that names the offending tokens. */
export function validateThemeJson(label: string, json: unknown): ValidatedThemeJson {
	if (
		typeof json === "object" &&
		json !== null &&
		"name" in json &&
		typeof json.name === "string" &&
		json.name.includes("/")
	) {
		throw new Error(
			`Invalid theme name "${json.name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}

	if (!compiledThemeSchema.check(json)) {
		const errors = compiledThemeSchema.errors(json);
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.path.startsWith("/colors/")) {
				missingColors.add(error.path.slice("/colors/".length));
				continue;
			}

			const path = error.path || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	return json as ValidatedThemeJson;
}
