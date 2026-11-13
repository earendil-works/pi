// Browser-only component fixture, bundled by `Browser.loadFixture`: a switch whose value is "server state" changed only
// by its call, shown through `useOptimisticCall`. The test settles each call from outside: `pass()` commits the new value
// before the call resolves (as Chord applies the answering host's state before its answer), `refuse(message)` rejects.
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { errorText, useOptimisticCall } from "../../src/runtime/web.tsx";

type Settle = { pass: () => void; refuse: (message: string) => void };
const calls: Settle[] = [];

function Switch() {
	const [server, setServer] = useState(false);
	const [error, setError] = useState<string>();
	const [shown, run, pending] = useOptimisticCall(
		server,
		(_, next: boolean) => next,
		(reason) => setError(errorText(reason)),
	);
	const toggle = () => {
		const next = !shown;
		setError(undefined);
		run(
			next,
			() =>
				new Promise<void>((resolve, reject) =>
					calls.push({
						pass: () => {
							setServer(next);
							resolve();
						},
						refuse: (message) => reject(new Error(message)),
					}),
				),
		);
	};
	return createElement(
		"div",
		null,
		createElement("button", { id: "switch", type: "button", onClick: toggle }, shown ? "on" : "off"),
		createElement("span", { id: "pending" }, pending ? "pending" : "idle"),
		createElement("span", { id: "error" }, error ?? ""),
	);
}

const element = document.createElement("div");
document.body.replaceChildren(element);
createRoot(element).render(createElement(Switch));
Object.assign(window, {
	settleCall: (outcome: { pass: true } | { refuse: string }) => {
		const call = calls.shift();
		if (call && "pass" in outcome) call.pass();
		else call?.refuse("refuse" in outcome ? outcome.refuse : "");
	},
});
