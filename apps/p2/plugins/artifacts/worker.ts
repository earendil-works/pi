import type { ConversationId } from "@earendil-works/pi-durable";
import { canView, contribute, defineFacet, deriveTyped, forbidden } from "@p2/app/v1";
import { ARTIFACTS, Files } from "@p2/app/v1/node";
import { agentConversation, Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { FilesMirror } from "../files/contract.ts";
import { ArtifactContent, ArtifactList, ArtifactSource, MAX_ARTIFACT_PREVIEW } from "./contract.ts";
import { readArtifact, saveArtifact } from "./store.ts";
import { ArtifactDoc, createArtifactExtension, type SaveArtifact } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.artifact-tools", (self) => {
		const worker = workerOf(self);
		// Versions go into the session's files (space `artifacts`), in a root of the worker's own; the server's mirror
		// hears of the change before the tool answers.
		const save: SaveArtifact = (input, holder, context) =>
			worker().root(async (ctx) => {
				const info = await saveArtifact(await ctx.get(Files, {}), input, String(holder), ctx);
				await (await ctx.get(FilesMirror, {})).push(ARTIFACTS, ctx);
				return info;
			}, context);
		const extension = createArtifactExtension(save);
		self.contribute(Extensions, { [extension.name]: extension });
	});

	host.serve(ArtifactSource, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const files = self.get(Files, {});
		return {
			variant: "server",
			members: { read: ({ name, version }, ctx) => readArtifact(files, name, version, ctx) },
		};
	});

	host.serve(ArtifactContent, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const files = self.get(Files, {});
		return {
			variant: "reader",
			members: {
				read: async ({ name, version }, ctx) => {
					const { info, content } = await readArtifact(files, name, version, ctx);
					const truncated = content.length > MAX_ARTIFACT_PREVIEW;
					// Never split a surrogate pair at the cut.
					let end = MAX_ARTIFACT_PREVIEW;
					if (truncated && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end--;
					return { info, content: truncated ? content.slice(0, end) : content, truncated };
				},
			},
		};
	});

	host.serve(ArtifactList, ({ session, conversation }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const harness = harnessOf(self);
		const id = conversation as ConversationId;
		// The viewed agent's list (the main agent's on conversation 1), followed.
		const listed = self.follow(async (observer, ctx) => {
			const durable = harness().durable;
			if (!(await durable.conversation(id, ctx))) throw new Error(`Unknown conversation ${conversation}`);
			const holder = await agentConversation(durable, id, ctx);
			const observed = await durable.observeDoc(ArtifactDoc, holder, observer, ctx);
			if (observed !== undefined) return observed;
			// No artifact saved yet: the document is absent, and an absent address cannot be followed. Create it empty.
			await durable.commit(async (tx) => {
				await tx.doc(ArtifactDoc, holder);
			}, ctx);
			return durable.observeDoc(ArtifactDoc, holder, observer, ctx);
		});
		return { variant: "reader", members: { artifacts: deriveTyped(self, [listed], ([value]) => value.artifacts) } };
	});
});
