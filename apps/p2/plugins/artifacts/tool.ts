import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";
import { type ArtifactInfo, Artifacts } from "./store.ts";

type ArtifactState = { artifacts: ArtifactInfo[] };

/** Complete artifact index for one conversation; reset/compaction never rewind it. */
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
					"Create or update a session artifact (HTML, SVG, Markdown or text; maximum 2 MiB UTF-8). Reuse its stable lowercase slug name to publish a new immutable numbered version. Versions persist across restarts. All authorized viewers of this session may explicitly click to open an isolated preview; previews never open automatically. Do not publish secrets. HTML may use HTTPS CDN resources, but has no app identity or parent privileges.",
				parameters: obj({
					name: str({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", minLength: 1, maxLength: 64 }),
					title: str({ minLength: 1, maxLength: 200 }),
					type: union([literal("html"), literal("svg"), literal("markdown"), literal("text")]),
					content: str(),
				}),
				replay: "unsafe",
				execute: async (args, api, context) => {
					const info = await artifacts.save(sessionId, args);
					await api.commit(async (tx) => {
						const state = await tx.doc(ArtifactDoc, api.conversationId);
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
								text: `Artifact ready: ${info.title} (${info.name}, version ${info.version}).`,
							},
						],
						details: info,
					};
				},
			}),
		],
	});
}
