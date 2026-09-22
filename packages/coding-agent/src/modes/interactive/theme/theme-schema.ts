/**
 * Theme JSON validation, kept out of `theme.ts` on purpose.
 *
 * Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * `interactive-mode.ts` installs this validator; anything that does not simply skips validation, as
 * built-in themes already do.
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

function colorValue(description?: string) {
	return Type.Union(
		[
			Type.String({
				description: "Hex color (#RRGGBB), variable reference, or empty string for terminal default",
			}),
			Type.Integer({
				minimum: 0,
				maximum: 255,
				description: "256-color palette index (0-255)",
			}),
		],
		description ? { description } : {},
	);
}

const ColorValueSchema = colorValue();

export const ThemeJsonSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON schema reference" })),
		name: Type.String({
			pattern: "^[^/]+$",
			description:
				"Theme name. Must not contain '/' because it is reserved for automatic light/dark theme settings.",
		}),
		vars: Type.Optional(
			Type.Record(Type.String(), ColorValueSchema, {
				description: "Reusable color variables",
			}),
		),
		colors: Type.Object(
			{
				// Core UI (11 colors)
				accent: colorValue("Primary accent color (logo, selected items, cursor)"),
				border: colorValue("Normal borders"),
				borderAccent: colorValue("Highlighted borders"),
				borderMuted: colorValue("Subtle borders"),
				success: colorValue("Success states"),
				error: colorValue("Error states"),
				warning: colorValue("Warning states"),
				muted: colorValue("Secondary/dimmed text"),
				dim: colorValue("Very dimmed text (more subtle than muted)"),
				text: colorValue("Default text color (usually empty string)"),
				thinkingText: colorValue("Thinking block text color"),
				// Scrollbar (2 optional colors)
				scrollbarTrack: Type.Optional(
					colorValue("Fullscreen scrollbar track foreground (falls back to muted when omitted)"),
				),
				scrollbarThumb: Type.Optional(
					colorValue("Fullscreen scrollbar thumb foreground (falls back to text when omitted)"),
				),
				// Backgrounds & Content Text (11 required, 2 optional)
				selectedBg: colorValue("Selected item background"),
				searchMatchBg: Type.Optional(
					colorValue(
						"Transcript search match background and current-match text (falls back to selectedBg when omitted)",
					),
				),
				searchMatchText: Type.Optional(
					colorValue(
						"Transcript search match text and current-match background (falls back to text when omitted)",
					),
				),
				userMessageBg: colorValue("User message background"),
				userMessageText: colorValue("User message text color"),
				customMessageBg: colorValue("Custom message background (hook-injected messages)"),
				customMessageText: colorValue("Custom message text color"),
				customMessageLabel: colorValue("Custom message type label color"),
				toolPendingBg: colorValue("Tool execution box (pending state)"),
				toolSuccessBg: colorValue("Tool execution box (success state)"),
				toolErrorBg: colorValue("Tool execution box (error state)"),
				toolTitle: colorValue("Tool execution box title color"),
				toolOutput: colorValue("Tool execution box output text color"),
				// Markdown (10 colors)
				mdHeading: colorValue("Markdown heading text"),
				mdLink: colorValue("Markdown link text"),
				mdLinkUrl: colorValue("Markdown link URL"),
				mdCode: colorValue("Markdown inline code"),
				mdCodeBlock: colorValue("Markdown code block content"),
				mdCodeBlockBorder: colorValue("Markdown code block fences"),
				mdQuote: colorValue("Markdown blockquote text"),
				mdQuoteBorder: colorValue("Markdown blockquote border"),
				mdHr: colorValue("Markdown horizontal rule"),
				mdListBullet: colorValue("Markdown list bullets/numbers"),
				// Tool Diffs (3 colors)
				toolDiffAdded: colorValue("Added lines in tool diffs"),
				toolDiffRemoved: colorValue("Removed lines in tool diffs"),
				toolDiffContext: colorValue("Context lines in tool diffs"),
				// Syntax Highlighting (9 colors)
				syntaxComment: colorValue("Syntax highlighting: comments"),
				syntaxKeyword: colorValue("Syntax highlighting: keywords"),
				syntaxFunction: colorValue("Syntax highlighting: function names"),
				syntaxVariable: colorValue("Syntax highlighting: variable names"),
				syntaxString: colorValue("Syntax highlighting: string literals"),
				syntaxNumber: colorValue("Syntax highlighting: number literals"),
				syntaxType: colorValue("Syntax highlighting: type names"),
				syntaxOperator: colorValue("Syntax highlighting: operators"),
				syntaxPunctuation: colorValue("Syntax highlighting: punctuation"),
				// Thinking Level Borders (6 colors)
				thinkingOff: colorValue("Thinking level border: off"),
				thinkingMinimal: colorValue("Thinking level border: minimal"),
				thinkingLow: colorValue("Thinking level border: low"),
				thinkingMedium: colorValue("Thinking level border: medium"),
				thinkingHigh: colorValue("Thinking level border: high"),
				thinkingXhigh: colorValue("Thinking level border: xhigh"),
				thinkingMax: Type.Optional(
					colorValue("Thinking level border: max (falls back to thinkingXhigh when omitted)"),
				),
				// Bash Mode (1 color)
				bashMode: colorValue("Editor border color in bash mode"),
			},
			{
				description:
					"Theme color definitions (scrollbar, thinkingMax, and search highlight colors are optional and use compatible fallbacks)",
				additionalProperties: false,
			},
		),
		export: Type.Optional(
			Type.Object(
				{
					pageBg: Type.Optional(colorValue("Page background color")),
					cardBg: Type.Optional(colorValue("Card/container background color")),
					infoBg: Type.Optional(colorValue("Info sections background (system prompt, notices)")),
				},
				{
					description: "Optional colors for HTML export (defaults derived from userMessageBg if not specified)",
					additionalProperties: false,
				},
			),
		),
	},
	{
		title: "Pi Coding Agent Theme",
		description: "Theme schema for Pi coding agent",
		additionalProperties: false,
	},
);

const compiledThemeSchema = Compile(ThemeJsonSchema);

export type ThemeColorValue = Static<typeof ColorValueSchema>;
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

	if (!compiledThemeSchema.Check(json)) {
		const errors = Array.from(compiledThemeSchema.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
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
