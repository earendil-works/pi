import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW,
} from "../../prompts/prompts.js";
import type { SandboxRuntimeProvider } from "./SandboxRuntimeProvider.js";

// Define minimal interface for ArtifactsPanel to avoid circular dependencies
interface ArtifactsPanelLike {
	artifacts: Map<string, { content: string }>;
	tool: {
		execute(toolCallId: string, args: { command: string; filename: string; content?: string }): Promise<any>;
	};
}

interface AgentLike {
	state: { messages: AgentMessage[] };
}

/**
 * Artifacts Runtime Provider
 *
 * Provides programmatic access to session artifacts from sandboxed code.
 * Allows code to create, read, update, and delete artifacts dynamically.
 * Supports both online (extension) and offline (downloaded HTML) modes.
 */
export class ArtifactsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(
		private artifactsPanel: ArtifactsPanelLike,
		private agent?: AgentLike,
		private readWrite: boolean = true,
	) {}

	getData(): Record<string, any> {
		// Inject artifact snapshot for offline mode
		const snapshot: Record<string, string> = {};
		this.artifactsPanel.artifacts.forEach((artifact, filename) => {
			snapshot[filename] = artifact.content;
		});
		return { artifacts: snapshot };
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified, so no external references!
		return (_sandboxId: string) => {
			// Auto-parse/stringify for .json files
			const isJsonFile = (filename: string) => filename.endsWith(".json");

			(window as any).listArtifacts = async (): Promise<string[]> => {
				// Online: ask extension
				if ((window as any).sendRuntimeMessage) {
					const response = await (window as any).sendRuntimeMessage({
						type: "artifact-operation",
						action: "list",
					});
					if (!response.success) throw new Error(response.error);
					return response.result;
				}
				// Offline: return snapshot keys
				else {
					return Object.keys((window as any).artifacts || {});
				}
			};

			(window as any).getArtifact = async (filename: string): Promise<any> => {
				let content: string;

				// Online: ask extension
				if ((window as any).sendRuntimeMessage) {
					const response = await (window as any).sendRuntimeMessage({
						type: "artifact-operation",
						action: "get",
						filename,
					});
					if (!response.success) throw new Error(response.error);
					content = response.result;
				}
				// Offline: read snapshot
				else {
					if (!(window as any).artifacts?.[filename]) {
						throw new Error(`Artifact not found (offline mode): ${filename}`);
					}
					content = (window as any).artifacts[filename];
				}

				// Auto-parse .json files
				if (isJsonFile(filename)) {
					try {
						return JSON.parse(content);
					} catch (e) {
						throw new Error(`Failed to parse JSON from ${filename}: ${e}`);
					}
				}
				return content;
			};

			(window as any).createOrUpdateArtifact = async (
				filename: string,
				content: any,
				mimeType?: string,
			): Promise<void> => {
				if (!(window as any).sendRuntimeMessage) {
					throw new Error("Cannot create/update artifacts in offline mode (read-only)");
				}

				let finalContent = content;
				// Auto-stringify .json files
				if (isJsonFile(filename) && typeof content !== "string") {
					finalContent = JSON.stringify(content, null, 2);
				} else if (typeof content !== "string") {
					finalContent = JSON.stringify(content, null, 2);
				}

				const response = await (window as any).sendRuntimeMessage({
					type: "artifact-operation",
					action: "createOrUpdate",
					filename,
					content: finalContent,
					mimeType,
				});
				if (!response.success) throw new Error(response.error);
			};

			(window as any).deleteArtifact = async (filename: string): Promise<void> => {
				if (!(window as any).sendRuntimeMessage) {
					throw new Error("Cannot delete artifacts in offline mode (read-only)");
				}

				const response = await (window as any).sendRuntimeMessage({
					type: "artifact-operation",
					action: "delete",
					filename,
				});
				if (!response.success) throw new Error(response.error);
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "artifact-operation") {
			return;
		}

		const { action, filename, content } = message;

		try {
			switch (action) {
				case "list": {
					const filenames = Array.from(this.artifactsPanel.artifacts.keys());
					respond({ success: true, result: filenames });
					break;
				}

				case "get": {
					const artifact = this.artifactsPanel.artifacts.get(filename);
					if (!artifact) {
						respond({ success: false, error: `Artifact not found: ${filename}` });
					} else {
						respond({ success: true, result: artifact.content });
					}
					break;
				}

				case "createOrUpdate": {
					try {
						const exists = this.artifactsPanel.artifacts.has(filename);
						const command = exists ? "rewrite" : "create";
						const action = exists ? "update" : "create";

						await this.artifactsPanel.tool.execute("", {
							command,
							filename,
							content,
						});
						this.agent?.state.messages.push({
							role: "artifact",
							action,
							filename,
							content,
							...(action === "create" && { title: filename }),
							timestamp: new Date().toISOString(),
						});
						respond({ success: true });
					} catch (err: any) {
						respond({ success: false, error: err.message });
					}
					break;
				}

				case "delete": {
					try {
						await this.artifactsPanel.tool.execute("", {
							command: "delete",
							filename,
						});
						this.agent?.state.messages.push({
							role: "artifact",
							action: "delete",
							filename,
							timestamp: new Date().toISOString(),
						});
						respond({ success: true });
					} catch (err: any) {
						respond({ success: false, error: err.message });
					}
					break;
				}

				default:
					respond({ success: false, error: `Unknown artifact action: ${action}` });
			}
		} catch (error: any) {
			respond({ success: false, error: error.message });
		}
	}

	getDescription(): string {
		return this.readWrite ? ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW : ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO;
	}
}
