import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { bool, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";
import { agentConversation } from "@p2/app/v1/worker";
import { type ArtifactInfo, Artifacts } from "./store.ts";

type ArtifactState = { artifacts: ArtifactInfo[] };

/**
 * The tool's result details: the saved version, and `inline: true` when the call asked to show it at the call site
 * too (the transcripts render that version below the card). The index (`ArtifactDoc`) keeps only `ArtifactInfo`.
 */
export type ArtifactDetails = ArtifactInfo & { inline?: true };

/**
 * Complete artifact index of one agent (on conversation 1 for the main agent, see `agentConversation`); reset and
 * compaction never rewind it.
 */
export const ArtifactDoc = defineDoc<ArtifactState>({
	kind: "p2.artifacts",
	version: 1,
	scope: "conversation",
	history: "latest",
	// A latest-only document cannot copy state as of a historical fork point.
	// Start forks and independently created subagents with their own empty index.
	fork: "initial",
	initial: () => ({ artifacts: [] }),
	checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export function createArtifactExtension(dataDirectory: string, sessionId: string) {
	const artifacts = new Artifacts(dataDirectory);
	return defineExtension({
		name: "p2-artifacts",
		tools: [
			defineTool({
				name: "artifact",
				description:
					"Create or update a session artifact (HTML, SVG, Markdown or text; maximum 2 MiB UTF-8). Reuse its stable lowercase slug name to publish a new immutable numbered version. Versions persist across restarts. Viewers open an isolated preview from the card in the transcript. Set inline: true to also show this version right below the card, in the chat, for every viewer of the session: use it for diagrams (prefer SVG, e.g. sequence or architecture diagrams, over ASCII art), charts and other small visual results the reader should see without opening anything; keep inline content compact (it is shown at most about 70% of the screen high, then scrolls) and leave large documents and apps as plain artifacts. Do not publish secrets. HTML and SVG run in a sandbox with no app identity or parent privileges; HTML may use HTTPS CDN resources.",
				parameters: obj({
					name: str({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", minLength: 1, maxLength: 64 }),
					title: str({ minLength: 1, maxLength: 200 }),
					type: union([literal("html"), literal("svg"), literal("markdown"), literal("text")]),
					content: str(),
					inline: opt(
						bool({
							description:
								"Also render it inline at the tool call site in the transcript (default false). For diagrams and small visual results.",
						}),
					),
				}),
				replay: "unsafe",
				execute: async ({ inline, ...input }, api, context) => {
					const info = await artifacts.save(sessionId, input);
					// The main agent's list is one, whichever `/tree` branch it works in.
					const holder = await agentConversation(api, api.conversationId, context);
					await api.commit(async (tx) => {
						const state = await tx.doc(ArtifactDoc, holder);
						if (
							!state.artifacts.some(
								(artifact) => artifact.name === info.name && artifact.version === info.version,
							)
						)
							state.artifacts.push(info);
					}, context);
					return {
						output: [
							{
								type: "text" as const,
								text: `Artifact ready: ${info.title} (${info.name}, version ${info.version}).${inline ? " Shown inline in the transcript." : ""}`,
							},
						],
						details: (inline ? { ...info, inline: true } : info) satisfies ArtifactDetails,
					};
				},
			}),
		],
	});
}
