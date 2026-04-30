import { i18n } from "@mariozechner/mini-lit";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";
import { type Static, Type } from "typebox";
import { type SandboxFile, SandboxIframe, type SandboxResult } from "../components/SandboxedIframe.js";
import type { SandboxRuntimeProvider } from "../components/sandbox/SandboxRuntimeProvider.js";
import { JAVASCRIPT_REPL_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import type { Attachment } from "../utils/attachment-utils.js";
import { registerToolRenderer, renderCollapsibleHeader, renderHeader } from "./renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "./types.js";

// Execute JavaScript code with attachments using SandboxedIframe
export async function executeJavaScript(
	code: string,
	runtimeProviders: SandboxRuntimeProvider[],
	signal?: AbortSignal,
	sandboxUrlProvider?: () => string,
): Promise<{ output: string; files?: SandboxFile[] }> {
	if (!code) {
		throw new Error("Code parameter is required");
	}

	// Check for abort before starting
	if (signal?.aborted) {
		throw new Error("Execution aborted");
	}

	// Create a SandboxedIframe instance for execution
	const sandbox = new SandboxIframe();
	if (sandboxUrlProvider) {
		sandbox.sandboxUrlProvider = sandboxUrlProvider;
	}
	sandbox.style.display = "none";
	document.body.appendChild(sandbox);

	try {
		const sandboxId = `repl-${Date.now()}-${Math.random().toString(36).substring(7)}`;

		// Pass providers to execute (router handles all message routing)
		// No additional consumers needed - execute() has its own internal consumer
		const result: SandboxResult = await sandbox.execute(sandboxId, code, runtimeProviders, [], signal);

		// Remove the sandbox iframe after execution
		sandbox.remove();

		// Build plain text response
		let output = "";

		// Add console output - result.console contains { type: string, text: string } from sandbox.js
		if (result.console && result.console.length > 0) {
			for (const entry of result.console) {
				output += `${entry.text}\n`;
			}
		}

		// Add error if execution failed
		if (!result.success) {
			if (output) output += "\n";
			output += `Error: ${result.error?.message || "Unknown error"}\n${result.error?.stack || ""}`;

			// Throw error so tool call is marked as failed
			throw new Error(output.trim());
		}

		// Add return value if present
		if (result.returnValue !== undefined) {
			if (output) output += "\n";
			output += `=> ${typeof result.returnValue === "object" ? JSON.stringify(result.returnValue, null, 2) : result.returnValue}`;
		}

		// Add file notifications
		if (result.files && result.files.length > 0) {
			output += `\n[Files returned: ${result.files.length}]\n`;
			for (const file of result.files) {
				output += `  - ${file.fileName} (${file.mimeType})\n`;
			}
		} else {
			// Explicitly note when no files were returned (helpful for debugging)
			if (code.includes("returnFile")) {
				output += "\n[No files returned - check async operations]";
			}
		}

		return {
			output: output.trim() || "Code executed successfully (no output)",
			files: result.files,
		};
	} catch (error: unknown) {
		// Clean up on error
		sandbox.remove();
		throw new Error((error as Error).message || "Execution failed");
	}
}

export type JavaScriptReplToolResult = {
	files?:
		| {
				fileName: string;
				contentBase64: string;
				mimeType: string;
		  }[]
		| undefined;
};

const javascriptReplSchema = Type.Object({
	title: Type.String({
		description:
			"Brief title describing what the code snippet tries to achieve in active form, e.g. 'Calculating sum'",
	}),
	code: Type.String({ description: "JavaScript code to execute" }),
});

export type JavaScriptReplParams = Static<typeof javascriptReplSchema>;

interface JavaScriptReplResult {
	output?: string;
	files?: Array<{
		fileName: string;
		mimeType: string;
		size: number;
		contentBase64: string;
	}>;
}

export function createJavaScriptReplTool(): AgentTool<typeof javascriptReplSchema, JavaScriptReplToolResult> & {
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
	sandboxUrlProvider?: () => string;
} {
	return {
		label: "JavaScript REPL",
		name: "javascript_repl",
		runtimeProvidersFactory: () => [], // default to empty array
		sandboxUrlProvider: undefined, // optional, for browser extensions
		get description() {
			const runtimeProviderDescriptions =
				this.runtimeProvidersFactory?.()
					.map((d) => d.getDescription())
					.filter((d) => d.trim().length > 0) || [];
			return JAVASCRIPT_REPL_TOOL_DESCRIPTION(runtimeProviderDescriptions);
		},
		parameters: javascriptReplSchema,
		execute: async function (_toolCallId: string, args: Static<typeof javascriptReplSchema>, signal?: AbortSignal) {
			const result = await executeJavaScript(
				args.code,
				this.runtimeProvidersFactory?.() ?? [],
				signal,
				this.sandboxUrlProvider,
			);
			// Convert files to JSON-serializable with base64 payloads
			const files = (result.files || []).map((f) => {
				const toBase64 = (input: string | Uint8Array): { base64: string; size: number } => {
					if (input instanceof Uint8Array) {
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < input.length; i += chunk) {
							binary += String.fromCharCode(...input.subarray(i, i + chunk));
						}
						return { base64: btoa(binary), size: input.length };
					} else if (typeof input === "string") {
						const enc = new TextEncoder();
						const bytes = enc.encode(input);
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < bytes.length; i += chunk) {
							binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
						}
						return { base64: btoa(binary), size: bytes.length };
					} else {
						const s = String(input);
						const enc = new TextEncoder();
						const bytes = enc.encode(s);
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < bytes.length; i += chunk) {
							binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
						}
						return { base64: btoa(binary), size: bytes.length };
					}
				};

				const { base64, size } = toBase64(f.content);
				return {
					fileName: f.fileName || "file",
					mimeType: f.mimeType || "application/octet-stream",
					size,
					contentBase64: base64,
				};
			});
			return { content: [{ type: "text", text: result.output }], details: { files } };
		},
	};
}

// Export a default instance for backward compatibility
export const javascriptReplTool = createJavaScriptReplTool();

export const javascriptReplRenderer: ToolRenderer<JavaScriptReplParams, JavaScriptReplResult> = {
	render(
		params: JavaScriptReplParams | undefined,
		result: ToolResultMessage<JavaScriptReplResult> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Determine status
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		// Create refs for collapsible code section
		const codeContentRef = createRef<HTMLDivElement>();
		const codeChevronRef = createRef<HTMLSpanElement>();

		// With result: show params + result
		if (result && params) {
			const output =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			const files = result.details?.files || [];

			const attachments: Attachment[] = files.map((f, i) => {
				// Decode base64 content for text files to show in overlay
				let extractedText: string | undefined;
				const isTextBased =
					f.mimeType?.startsWith("text/") ||
					f.mimeType === "application/json" ||
					f.mimeType === "application/javascript" ||
					f.mimeType?.includes("xml");

				if (isTextBased && f.contentBase64) {
					try {
						extractedText = atob(f.contentBase64);
					} catch (_e) {
						console.warn("Failed to decode base64 content for", f.fileName);
					}
				}

				return {
					id: `repl-${Date.now()}-${i}`,
					type: f.mimeType?.startsWith("image/") ? "image" : "document",
					fileName: f.fileName || `file-${i}`,
					mimeType: f.mimeType || "application/octet-stream",
					size: f.size ?? 0,
					content: f.contentBase64,
					preview: f.mimeType?.startsWith("image/") ? f.contentBase64 : undefined,
					extractedText,
				};
			});

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Code, params.title ? params.title : i18n("Executing JavaScript"), codeContentRef, codeChevronRef, false)}
						<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
							<code-block .code=${params.code || ""} language="javascript"></code-block>
							${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
						</div>
						${
							attachments.length
								? html`<div class="flex flex-wrap gap-2 mt-3">
									${attachments.map((att) => html`<attachment-tile .attachment=${att}></attachment-tile>`)}
							  </div>`
								: ""
						}
					</div>
				`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting for result)
		if (params) {
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Code, params.title ? params.title : i18n("Executing JavaScript"), codeContentRef, codeChevronRef, false)}
						<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							${params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// No params or result yet
		return { content: renderHeader(state, Code, i18n("Preparing JavaScript...")), isCustom: false };
	},
};

// Auto-register the renderer
registerToolRenderer(javascriptReplTool.name, javascriptReplRenderer);
