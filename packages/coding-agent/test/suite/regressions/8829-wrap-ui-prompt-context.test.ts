// Issue #8829: wrapUIPromptContext copying by spread loses UI prototype methods
import { describe, expect, it } from "vitest";
import type { ExtensionError, ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { createHarness } from "../harness.ts";

describe("issue #8829: wrapUIPromptContext host UI shapes", () => {
	it("lets a session_start handler call class prototype setStatus/notify", async () => {
		class HostUi {
			statuses: Array<[string, string | undefined]> = [];
			notices: string[] = [];
			setStatus(key: string, text: string | undefined) {
				this.statuses.push([key, text]);
			}
			notify(message: string) {
				this.notices.push(message);
			}
		}

		const host = new HostUi();
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.setStatus("0-claude-max", "🧠 5h 19%");
						ctx.ui.notify("hello", "info");
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: host as unknown as ExtensionUIContext,
				onError: (error) => errors.push(error),
			});

			expect(errors).toEqual([]);
			expect(host.statuses).toEqual([["0-claude-max", "🧠 5h 19%"]]);
			expect(host.notices).toEqual(["hello"]);
		} finally {
			harness.cleanup();
		}
	});

	it("lets a session_start handler read a Proxy get-trap brand", async () => {
		const brand = Symbol("relay-ui");
		let seen: unknown;
		const proxied = new Proxy(
			{},
			{
				get(_target, prop) {
					if (prop === brand) return "child";
					return undefined;
				},
			},
		);

		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						seen = Reflect.get(ctx.ui, brand);
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: proxied as unknown as ExtensionUIContext,
				onError: (error) => errors.push(error),
			});

			expect(errors).toEqual([]);
			expect(seen).toBe("child");
		} finally {
			harness.cleanup();
		}
	});

	it("still wraps prompt methods with ui_prompt_start and ui_prompt_end events", async () => {
		const promptEvents: string[] = [];
		const selectMock = async (title: string, _options: string[]) => `selected:${title}`;

		const hostUi = {
			select: selectMock,
		};

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("ui_prompt_start", (event) => {
						promptEvents.push(`start:${event.kind}:${event.title}`);
					});
					pi.on("ui_prompt_end", (event) => {
						promptEvents.push(`end:${event.kind}:${event.title}`);
					});
				},
			],
		});

		try {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: hostUi as unknown as ExtensionUIContext,
			});

			const result = await harness.session.extensionRunner.getUIContext().select("choose one", ["a", "b"]);
			expect(result).toBe("selected:choose one");

			// Allow queued microtasks to flush
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(promptEvents).toEqual(["start:select:choose one", "end:select:choose one"]);
		} finally {
			harness.cleanup();
		}
	});
});
