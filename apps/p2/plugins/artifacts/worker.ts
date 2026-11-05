import type { ConversationId } from "@earendil-works/pi-durable";
import { canView, contribute, defineFacet, deriveTyped, forbidden } from "@p2/app/v1";
import { agentConversation, Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { ArtifactContent, ArtifactList, MAX_ARTIFACT_PREVIEW } from "./contract.ts";
import { Artifacts } from "./store.ts";
import { ArtifactDoc, createArtifactExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.artifact-tools", (self) => {
		const worker = workerOf(self);
		// The tool's declaration; each call saves for the worker's session.
		const template = createArtifactExtension("", "");
		self.contribute(Extensions, {
			[template.name]: {
				...template,
				tools: template.tools!.map((tool) => ({
					...tool,
					execute: (...args: Parameters<typeof tool.execute>) =>
						createArtifactExtension(worker().init.dataDir, worker().init.values.session.id).tools![0]!.execute(
							...args,
						),
				})),
			},
		});
	});

	host.serve(ArtifactContent, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const worker = workerOf(self);
		return {
			variant: "reader",
			members: {
				read: async ({ name, version }) => {
					const { info, content } = await new Artifacts(worker().init.dataDir).read(session, name, version);
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
