// Run by attempt.test.ts in a process of its own (it listens for unhandled rejections): a derive throwing a value
// without a string form fails its activation with a TypeError (the conversion in its failure throws), which is
// unhandled; another rejection made a few turns after the hold must come first, as before the hot-path pass, where
// the activation's own steps were an async function whose rejection took the turns it takes. Prints the orders.
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, local } from "../../../src/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";

const Throwing = local("app.throwing", { version: 1, params: { id: int() }, members: { n: int() } });
const host = createHost({ onError: () => {} });
const facet = defineFacet((h) =>
	h.serve(Throwing, (_, self) => ({
		n: self.derive([], () => {
			throw Object.create(null);
		}),
	})),
);
await host.load([{ name: "@test/app", facet }], context);
let log: string[] = [];
process.on("unhandledRejection", (reason) => void log.push(reason === "other" ? "other" : String(reason)));
const traces: string[] = [];
for (const turns of [3, 4]) {
	log = [];
	host.hold(Throwing, { id: turns }, context);
	let left = turns;
	const other = (): void => {
		if (left-- <= 0) {
			void Promise.reject("other");
			return;
		}
		queueMicrotask(other);
	};
	other();
	await new Promise((resolve) => setImmediate(resolve));
	traces.push(log.join(" ; "));
}
await host.close(context);
console.log(JSON.stringify(traces));
