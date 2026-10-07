import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { allowNetwork } from "./test-network-env.ts";

type RebindContext = {
	session: { modelRuntime: ModelRuntime };
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	subscribeToAgent: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	updateAvailableProviderCount: () => void;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// #10353: Session switches create fresh providers and must restart authenticated model discovery.
describe("InteractiveMode session model discovery", () => {
	it("refreshes availability for initial and replacement session runtimes", async () => {
		allowNetwork();
		const credentials = AuthStorage.inMemory({ openrouter: { type: "api_key", key: "workspace-key" } });
		const modelsStore = new InMemoryModelsStore();
		const createRuntime = () => ModelRuntime.create({ credentials, modelsStore, modelsPath: null });
		const runtime = await createRuntime();
		const [allowed] = runtime.getModels("openrouter");
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			return new URL(request.url).pathname.endsWith("/models/user")
				? Response.json({ data: [{ id: allowed.id }] })
				: new Response(null, { status: 404 });
		});
		const context: RebindContext = {
			session: { modelRuntime: runtime },
			applyRuntimeSettings: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			subscribeToAgent: vi.fn(),
			bindCurrentSessionExtensions: vi.fn(async () => {}),
			updateAvailableProviderCount: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
		};
		const availableIds = () =>
			context.session.modelRuntime
				.getAvailableSnapshot()
				.filter((model) => model.provider === "openrouter")
				.map((model) => model.id);

		await interactiveModePrototype.rebindCurrentSession.call(context);
		await vi.waitFor(() => expect(availableIds()).toEqual([allowed.id]));

		context.session = { modelRuntime: await createRuntime() };
		expect(availableIds().length).toBeGreaterThan(1);
		await interactiveModePrototype.rebindCurrentSession.call(context, { renderBeforeBind: true });
		await vi.waitFor(() => expect(availableIds()).toEqual([allowed.id]));
	});
});
