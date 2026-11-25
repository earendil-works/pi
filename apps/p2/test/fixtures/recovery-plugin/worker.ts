// Test only (ui-recovery.test.ts): writes the views document as p2 before 2026-11-12 wrote it (custom views, `path`,
// view errors, an arrangement naming a custom view), and a composer slot that can fail (web.tsx).
import { defineDoc, defineExtension } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { contribute, defineFacet, type JsonValue } from "@p2/app/v1";
import { defineP2Tool, Extensions, harnessOf, type P2Tool } from "@p2/app/v1/worker";

/** The document as any version wrote it: plain JSON. */
type OldState = { [key: string]: JsonValue };

const OldViews = defineDoc<OldState>({
	kind: "p2.views",
	version: 1,
	scope: "session",
	initial: () => ({ views: [], annotations: [] }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 32,
});

export default defineFacet((host) => {
	contribute(host, "seed.tools", (self) => {
		const harness = harnessOf(self);
		const extension = defineExtension<P2Tool>({
			name: "seed",
			tools: [
				defineP2Tool({
					name: "seed_old_views",
					description: "Writes old-shaped views.",
					parameters: obj({}),
					replay: "unsafe",
					callers: ["tools"],
					execute: async (_args, _api, context) => {
						const now = Date.now();
						await harness().durable.commit(async (tx) => {
							const draft = await tx.doc(OldViews);
							draft.views = [
								{
									id: "glyph",
									kind: "custom",
									title: "Glyph editor",
									source: 3,
									errors: ["TypeError: x"],
									selection: { summary: "point 1", data: { point: 1 }, sent: true },
									focus: now - 5000,
									created: now - 9000,
								},
								{
									id: "notes",
									kind: "markdown",
									title: "Notes",
									path: "notes.md",
									focus: now - 4000,
									created: now - 8000,
								},
								{ id: "diff", kind: "changes", title: "Changes", focus: now - 3000, created: now - 7000 },
								...((draft.views as JsonValue[] | undefined) ?? []),
							];
							draft.arrangement = { layout: { row: ["transcript", "glyph"] }, stamp: now - 1000 };
							draft.annotations = [
								{
									id: "a1",
									kind: "comment",
									view: "glyph",
									quote: "point",
									note: "bigger",
									author: "Owner",
									created: now - 2000,
									sent: true,
								},
								{
									id: "a2",
									kind: "ink",
									view: "glyph",
									strokes: [[0.1, 0.1, 0.5, 0.5]],
									aspect: 1,
									under: "x",
									author: "Owner",
									created: now - 1000,
									sent: true,
								},
							];
						}, context);
						return { output: [{ type: "text" as const, text: "seeded" }] };
					},
				}),
			],
		});
		self.contribute(Extensions, { [extension.name]: extension });
	});
});
