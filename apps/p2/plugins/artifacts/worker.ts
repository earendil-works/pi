import type { ConversationId } from "@earendil-works/pi-durable";
import { arr, obj } from "@earendil-works/pi-schema";
import {
	type Context,
	canView,
	contribute,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	signalOf,
} from "@p2/app/v1";
import { agentConversation, CommitSignal, Extensions, harnessOf, workerOf } from "@p2/app/v1/worker";
import { ArtifactContent, ArtifactInfoSchema, ArtifactList, MAX_ARTIFACT_PREVIEW } from "./contract.ts";
import { Artifacts } from "./store.ts";
import { ArtifactDoc, createArtifactExtension } from "./tool.ts";

/** The artifacts of one conversation (in memory, from its document). */
const Listed = defineTypedState("p2.artifact-list", {
	schema: obj({ artifacts: arr(ArtifactInfoSchema) }),
	version: 1,
	initial: () => ({ artifacts: [] }),
});

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
		const listed = self.state(Listed);
		/** Where the viewed agent's list is (the main agent's on conversation 1); set when the object opens. */
		let holder = id;
		const show = async (ctx: Context) => {
			const doc = await harness().durable.snapshot(ArtifactDoc, holder, ctx);
			await listed.change((draft) => {
				// A draft's arrays are mutable; the document's are the same JSON.
				draft.artifacts = [...(doc?.artifacts ?? [])] as typeof draft.artifacts;
			}, ctx);
		};
		const commits = self.open(
			async (ctx) => {
				const durable = harness().durable;
				if (!(await durable.conversation(id, ctx))) throw new Error(`Unknown conversation ${conversation}`);
				holder = await agentConversation(durable, id, ctx);
				await show(ctx);
				return new CommitSignal(durable, (publication) =>
					publication.changes.some(
						(change) =>
							change.type === "document" &&
							change.record.kind === ArtifactDoc.definition.kind &&
							change.conversationId === holder,
					),
				);
			},
			(signal) => signal.close(),
		);
		self.onLive(async (ctx) => {
			const signal = signalOf(ctx);
			while (!signal.aborted) {
				const seen = commits.value.version;
				await show(ctx);
				await commits.value.next(seen, signal).catch(() => {});
			}
		});
		return { variant: "reader", members: { artifacts: deriveTyped(self, [listed], ([value]) => value.artifacts) } };
	});
});
