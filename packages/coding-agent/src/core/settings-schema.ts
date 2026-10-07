import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { type Static, type TSchemaOptions, Type } from "typebox";
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";

function nonNegativeSafeInteger(options: { default?: number } = {}) {
	return Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, ...options });
}

function timeoutSetting(options?: TSchemaOptions) {
	return Type.Union([Type.Number({ minimum: 0 }), Type.Literal("disabled")], options);
}

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(nonNegativeSafeInteger()),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger()),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.compaction.enabled })),
	reserveTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.reserveTokens })),
	keepRecentTokens: Type.Optional(nonNegativeSafeInteger({ default: SETTINGS_DEFAULTS.compaction.keepRecentTokens })),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({
			description: "Tokens reserved for the prompt and LLM response.",
			default: SETTINGS_DEFAULTS.branchSummary.reserveTokens,
		}),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({
			description: "Maximum server-requested delay before failing.",
			default: SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		}),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.retry.enabled })),
	maxRetries: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxRetries })),
	baseDelayMs: Type.Optional(
		Type.Number({
			description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.",
			default: SETTINGS_DEFAULTS.retry.baseDelayMs,
		}),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: SETTINGS_DEFAULTS.retry.maxAgentDelayMs })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({
			description: "Legacy retry delay setting. Use provider.maxRetryDelayMs instead.",
			deprecated: true,
		}),
	),
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({
			description: "Show images when the terminal supports them.",
			default: SETTINGS_DEFAULTS.terminal.showImages,
		}),
	),
	imageWidthCells: Type.Optional(
		Type.Number({
			description: "Preferred inline image width in terminal cells.",
			default: SETTINGS_DEFAULTS.terminal.imageWidthCells,
		}),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({
			description: "Clear empty rows when content shrinks.",
			default: SETTINGS_DEFAULTS.terminal.clearOnShrink,
		}),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({
			description: "Show OSC 9;4 terminal progress indicators.",
			default: SETTINGS_DEFAULTS.terminal.showTerminalProgress,
		}),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: SETTINGS_DEFAULTS.images.autoResize,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({
			description: "When true, prevents all images from being sent to LLM providers.",
			default: SETTINGS_DEFAULTS.images.blockImages,
		}),
	),
});

function thinkingBudgetsSettings(options?: TSchemaOptions) {
	return Type.Object(
		{
			minimal: Type.Optional(Type.Number()),
			low: Type.Optional(Type.Number()),
			medium: Type.Optional(Type.Number()),
			high: Type.Optional(Type.Number()),
		},
		options,
	);
}

const ThinkingBudgetsSettingsSchema = thinkingBudgetsSettings();

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: SETTINGS_DEFAULTS.markdown.codeBlockIndent })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: SETTINGS_DEFAULTS.markdown.mermaid,
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.warnings.anthropicExtraUsage })),
});

function codemodeMode(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("on"), Type.Literal("only")], options);
}

const CodemodeModeSchema = codemodeMode();

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(
		codemodeMode({
			description:
				'How codemode presents tools. "on" keeps direct tools declared and annotates tools callable from scripts; codemode lists only tools without direct exposure. "only" lists every script-callable tool in codemode and does not declare active direct tools.',
			default: SETTINGS_DEFAULTS.codemode.mode,
		}),
	),
	inlineBudget: Type.Optional(
		Type.Number({
			description: "Estimated tokens available for inline codemode tool declarations.",
			default: SETTINGS_DEFAULTS.codemode.inlineBudget,
		}),
	),
});

const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ModelThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ModelThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: SETTINGS_DEFAULTS.transport },
			),
		),
		steeringMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.steeringMode,
			}),
		),
		followUpMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				default: SETTINGS_DEFAULTS.followUpMode,
			}),
		),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean({ default: SETTINGS_DEFAULTS.hideThinkingBlock })),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({
				description: "Show cache cost and provider recovery notices.",
				default: SETTINGS_DEFAULTS.showCacheMissNotices,
			}),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({
				description: "Custom shell path, for example for Cygwin on Windows, with support for leading ~ expansion.",
			}),
		),
		quietStartup: Type.Optional(
			Type.Union([Type.Boolean(), Type.Literal("header")], {
				description: 'When true, hide all startup output. When "header", keep only the startup header.',
				default: SETTINGS_DEFAULTS.quietStartup,
			}),
		),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: SETTINGS_DEFAULTS.defaultProjectTrust,
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
				default: SETTINGS_DEFAULTS.collapseChangelog,
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description: "Send an anonymous version and update ping after changelog-detected updates.",
				default: SETTINGS_DEFAULTS.enableInstallTelemetry,
			}),
		),
		enableAnalytics: Type.Optional(
			Type.Boolean({
				description: "Opt in to analytics data sharing.",
				default: SETTINGS_DEFAULTS.enableAnalytics,
			}),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		deviceId: Type.Optional(
			Type.String({
				description: "Stable installation UUID, generated when authentication first needs it. Global only.",
			}),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({
				description: "Register skills as /skill:name commands.",
				default: SETTINGS_DEFAULTS.enableSkillCommands,
			}),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		defaultTools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Initial tool selection. Plain names replace the inherited selection; +name and -name entries add or remove tools.",
			}),
		),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: SETTINGS_DEFAULTS.doubleEscapeAction,
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{
					description: "Default filter when opening /tree.",
					default: SETTINGS_DEFAULTS.treeFilterMode,
				},
			),
		),
		thinkingBudgets: Type.Optional(
			thinkingBudgetsSettings({
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({
				description: "Horizontal padding for the input editor.",
				default: SETTINGS_DEFAULTS.editorPaddingX,
			}),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for transcript content.",
				default: SETTINGS_DEFAULTS.outputPad,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({
				description: "Maximum visible items in the autocomplete dropdown.",
				default: SETTINGS_DEFAULTS.autocompleteMaxVisible,
			}),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		codemode: Type.Optional(CodemodeSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients." }),
		),
		httpIdleTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'HTTP header or body idle timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: SETTINGS_DEFAULTS.cacheWarming,
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			timeoutSetting({
				description: 'WebSocket connect or open handshake timeout in milliseconds; 0 or "disabled" disables it.',
			}),
		),
		tuiMode: Type.Optional(
			Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], {
				default: SETTINGS_DEFAULTS.tuiMode,
			}),
		),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenExitOutput,
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenScrollbar,
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({
				description: "No effect in regular TUI mode.",
				default: SETTINGS_DEFAULTS.fullscreenCopyOnSelect,
			}),
		),
		fullscreenWheelScrollLines: Type.Optional(
			Type.Union([Type.Number(), Type.Literal("auto")], {
				description: "Lines scrolled per wheel event in fullscreen mode; numeric values are clamped from 1 to 100.",
				default: SETTINGS_DEFAULTS.fullscreenWheelScrollLines,
			}),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export interface CodemodeSettings extends Static<typeof CodemodeSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type QuietStartup = NonNullable<SettingsInput["quietStartup"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
