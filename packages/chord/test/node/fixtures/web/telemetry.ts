// The web entry of the page telemetry test (the base bundle): `startPage` recording (`telemetry: true`), and a button
// whose click writes a project's note on its worker in a root span of the page (`host.root`'s `trace`), so the trace
// runs page → server → worker.

import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import * as chord from "../../../../src/index.ts";
import { startPage } from "../../../../src/web/index.ts";
import * as webApi from "./api.ts";

const { hostKind, method, remote, str, unknown, int } = chord;

/** The notes plugin's contract (`NOTES_PLUGIN` of the app tests), declared again: contracts are data. */
const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => hostKind("project", { id: str() })({ id }),
	variants: {
		main: {
			state: { text: str(), start: unknown() },
			methods: {
				write: method(str()),
				visit: method(str(), int()),
				attach: method(str(), str()),
				file: method(str(), str()),
			},
		},
	},
});

/** What the test reads from the page. */
const probe = globalThis as unknown as { written?: number };

void startPage({
	connect: () => new WebSocket(`${location.origin.replace(/^http/, "ws")}/chord`),
	modules: { "@test/app/v1": chord, "@test/app/v1/web": webApi },
	telemetry: true,
	render: (host) => {
		const notes = host.hold(Notes, { id: "p1" }, BACKGROUND_CONTEXT);
		const button = document.createElement("button");
		button.id = "write";
		button.textContent = "write";
		button.addEventListener("click", () => {
			void host
				.root((ctx) => notes.write("from the page", ctx), BACKGROUND_CONTEXT, { trace: { name: "page.write" } })
				.then(() => {
					probe.written = (probe.written ?? 0) + 1;
				});
		});
		const panels = document.createElement("div");
		panels.id = "panels";
		document.getElementById("root")!.append(panels, button);
	},
});
