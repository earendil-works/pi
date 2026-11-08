import { type AuthOperationOptions, StringEnum } from "@earendil-works/pi-ai";
import { arr, bool, compile, int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { stripBom, stripJsonComments } from "./config-json.ts";
import { LockedFile } from "./locked-file.ts";

const integer = (minimum: number) => int({ minimum });
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const queueModes = ["all", "one-at-a-time"] as const;
const schema = obj({
	defaultModel: opt(obj({ provider: str({ minLength: 1 }), modelId: str({ minLength: 1 }) })),
	thinkingLevel: opt(StringEnum(thinkingLevels)),
	/**
	 * p2 addition (pi's `enabledModels`): model patterns for the TUI's scoped model cycling, in order. Each is
	 * `provider/modelId` or `modelId`, a `*`/`?` glob over either, with an optional `:thinkingLevel`.
	 */
	enabledModels: opt(arr(str({ minLength: 1, maxLength: 300 }), { maxItems: 500 })),
	stream: opt(
		obj({
			transport: opt(StringEnum(["auto", "sse", "websocket"] as const)),
			timeoutMs: opt(integer(1)),
			maxRetries: opt(integer(0)),
			maxRetryDelayMs: opt(integer(0)),
			cacheRetention: opt(StringEnum(["none", "short", "long"] as const)),
		}),
	),
	retry: opt(
		obj({
			enabled: opt(bool()),
			maxRetries: opt(integer(0)),
			baseDelayMs: opt(integer(0)),
			maxAgentDelayMs: opt(integer(0)),
		}),
	),
	compaction: opt(
		obj({
			enabled: opt(bool()),
			reserveTokens: opt(integer(1)),
			keepRecentTokens: opt(integer(1)),
			backgroundTokens: opt(integer(0)),
		}),
	),
	toolExecution: opt(StringEnum(["parallel", "sequential"] as const)),
	steeringMode: opt(StringEnum(queueModes)),
	followUpMode: opt(StringEnum(queueModes)),
	/**
	 * Offer the durable `codemode` tool (scripts that call the other tools), with the codemode plugin loaded.
	 * Default on in p2 (Pi Mobile: off); `false` uninstalls it live from every worker.
	 */
	codemode: opt(bool()),
	/**
	 * pi's `cacheWarming`, kept by the cache-warming plugin: "idle" (default) keeps a conversation's prompt cache entry
	 * warm while its run streams and for up to 30 minutes after it settled, "streaming" only while it streams, "off"
	 * never.
	 */
	cacheWarming: opt(StringEnum(["off", "streaming", "idle"] as const)),
	/**
	 * p2 addition: how much of a turn the web chat shows, from 1 (only the answer; everything else on one wheel per
	 * turn) to 4 (thinking in full and each tool call as a row; no wheels). Default 2: the agent's texts in the
	 * transcript, thinking and tool calls on a wheel between them. See `Detail` in src/web/activity/model.ts.
	 */
	detail: opt(int({ minimum: 1, maximum: 4 })),
	/**
	 * p2 addition: the owner's name on the entries the owner writes from now on (default "Owner"); entries already
	 * written keep the name they were written with. No control characters, `<` or `>`.
	 */
	ownerName: opt(
		str({
			minLength: 1,
			maxLength: 40,
			pattern: "^[^<>\\u0000-\\u001f\\u007f]*\\S[^<>\\u0000-\\u001f\\u007f]*$",
		}),
	),
});
const validator = compile(schema);
export type MobileSettings = Static<typeof schema>;

export function validateSettings(value: unknown): MobileSettings {
	if (!validator.check(value)) throw new Error("Invalid settings.json configuration");
	return structuredClone(value) as MobileSettings;
}
export function parseSettings(content: string): MobileSettings {
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		throw new Error("Invalid settings.json syntax");
	}
	return validateSettings(value);
}
export async function saveSettings(path: string, value: unknown, options?: AuthOperationOptions): Promise<void> {
	const settings = validateSettings(value);
	await new LockedFile(path).withLockAsync(
		async () => ({
			result: undefined,
			next: JSON.stringify(settings, null, 2),
		}),
		options,
	);
}
