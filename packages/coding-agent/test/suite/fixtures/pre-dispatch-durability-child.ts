import { createHarness } from "../harness.ts";

const harness = await createHarness({
	persistSession: true,
	preDispatchDurability: true,
	extensionFactories: [
		(pi) => {
			pi.on("input", () => {
				pi.appendEntry("work-together-attribution", {
					requestId: "turn-fr10",
					principalId: "human-1",
				});
			});
		},
	],
});

harness.session.agent.streamFunction = async () => {
	const sessionFile = harness.sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error("persisted test session has no file path");
	}
	process.send?.({ sessionFile });
	return await new Promise<never>(() => {});
};

await harness.session.prompt("durably dispatch this turn");
