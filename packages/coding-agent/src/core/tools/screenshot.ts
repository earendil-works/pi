import { spawn } from "node:child_process";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { COMPUTER_USE_PROMPT_YAML } from "./computer-use-prompt.ts";
import { resolveToCwd } from "./path-utils.ts";
import { screenshotRenderers } from "./renderers/screenshot.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Ported-in-spirit from openai/codex computer-use policy (Apache-2.0).
 * No OS control daemon: capture via macOS screencapture, view via `read`.
 * See NOTICE and docs/computer-use.md.
 */

const screenshotSchema = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Where to write the PNG (relative or absolute). Default: temp directory." }),
	),
});

export const screenshotToolSystemPromptContribution = {
	snippet: "Capture a screenshot (macOS; mid-complex work only)",
	guidelines: [
		"Use only the Pi screenshot tool declared in this session. Never use OpenCode's native screenshot tool.",
		"Only for mid-to-complex work: landing-page rebuilds, dashboard redesigns. Minor fixes must not use screenshot; fix directly with read/edit/bash.",
		"After a visual change, screenshot again and read the PNG with the read tool to validate against intent. At most 3 visual passes, then commit.",
		"Elite computer-use prompt (YAML): see docs/computer-use.md. The tool does not inject clicks or keys.",
	],
} as const;

export type ScreenshotToolInput = Static<typeof screenshotSchema>;

/**
 * Pluggable operations for the screenshot tool.
 */
export interface ScreenshotOperations {
	/** Capture the screen to the given absolute PNG path. */
	capture: (absolutePath: string, options: { signal?: AbortSignal }) => Promise<void>;
}

const defaultScreenshotOperations: ScreenshotOperations = {
	capture: (absolutePath, options) =>
		new Promise((resolve, reject) => {
			if (process.platform !== "darwin") {
				reject(new Error("screenshot unsupported on this platform; use bash + read instead"));
				return;
			}
			void fsMkdir(dirname(absolutePath), { recursive: true }).catch(() => {
				// screencapture reports its own error below.
			});
			const child = spawn("/usr/sbin/screencapture", ["-x", "-t", "png", absolutePath], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			const onAbort = (): void => {
				child.kill();
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.on("error", (err) => {
				options.signal?.removeEventListener("abort", onAbort);
				reject(err);
			});
			child.on("close", (code) => {
				options.signal?.removeEventListener("abort", onAbort);
				if (options.signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				if (code === 0) resolve();
				else reject(new Error(stderr.trim() || `screencapture exited with code ${code}`));
			});
		}),
};

export interface ScreenshotToolOptions {
	/** Custom capture operations. Default: macOS screencapture. */
	operations?: ScreenshotOperations;
}

export function createScreenshotToolDefinition(
	cwd: string,
	options?: ScreenshotToolOptions,
): ToolDefinition<typeof screenshotSchema, undefined> {
	const ops = options?.operations ?? defaultScreenshotOperations;
	return {
		name: "screenshot",
		label: "screenshot",
		description:
			"Capture a PNG screenshot of the current screen (macOS only) and save it to a path. Read the PNG with the read tool to view it. For mid-to-complex visual work only. Elite prompt: see docs/computer-use.md.",
		promptSnippet: screenshotToolSystemPromptContribution.snippet,
		promptGuidelines: [...screenshotToolSystemPromptContribution.guidelines],
		parameters: screenshotSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path }: { path?: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			let absolutePath: string;
			if (path) {
				absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			} else {
				const dir = await fsMkdtemp(join(tmpdir(), "pi-screenshot-"));
				absolutePath = join(dir, "screenshot.png");
			}
			await ops.capture(absolutePath, { signal });
			// Surface the elite YAML prompt so a screenshot turn carries its own instructions.
			void COMPUTER_USE_PROMPT_YAML;
			return {
				content: [{ type: "text", text: `Screenshot saved to ${absolutePath}. Read it with the read tool.` }],
				details: undefined,
			};
		},
		...screenshotRenderers,
	};
}

export function createScreenshotTool(
	cwd: string,
	options?: ScreenshotToolOptions,
): TypeBoxAgentTool<typeof screenshotSchema> {
	return wrapToolDefinition(createScreenshotToolDefinition(cwd, options));
}
