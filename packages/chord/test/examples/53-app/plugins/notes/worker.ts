// The notes plugin's worker facet: the project's text in a persisted document (kept by a local object with empty
// params, the worker's one copy: a persisted state needs a stable identity), its attachments in the project's files
// (the kit's `Files`), and the start data the app gave the worker (`WorkerInfo`).

import { defineFacet, defineState, Files, local, method, obj, str, WorkerInfo } from "@notes/app/v1";
import { Notes } from "./contract.ts";

const Text = defineState("notes.text", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "" }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

/** The project's text, one per worker. */
const Store = local("notes.store", { version: 1, params: {}, members: { text: str(), write: method(str()) } });

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const text = self.state(Text);
		return {
			text: self.derive([text], ([value]) => value.text),
			write: async (next, ctx) => {
				await text.change((draft) => {
					draft.text = next;
				}, ctx);
				return null;
			},
		};
	});
	host.serve(Notes, (_params, _principal, self) => {
		const store = self.get(Store, {});
		const info = self.get(WorkerInfo, {});
		const files = self.get(Files, {});
		return {
			variant: "main",
			members: {
				text: self.derive([store.text], ([text]) => text),
				start: self.derive([info.start], ([start]) => JSON.stringify(start)),
				write: (next, ctx) => store.write(next, ctx),
				// An attachment is a file of the space `attachments` at its name; writing a name again adds a version.
				attach: async ({ name, body }, ctx) => {
					const bytes = new TextEncoder().encode(body);
					return (
						await files.put({ space: "attachments", path: name, mime: "text/plain", source: "notes", bytes }, ctx)
					).id;
				},
				attachment: async (id, ctx) =>
					new TextDecoder().decode(await files.read({ id, offset: 0, length: 65536 }, ctx)),
			},
		};
	});
});
