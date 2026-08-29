import { describe, expect, it } from "vitest";
import type { ExtensionError, ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import { createHarness } from "../harness.ts";

/**
 * wrapUIPromptContext used to `{...ui}`, which drops class prototype
 * methods and Proxy get-trap properties. These go through AgentSession.bindExtensions
 * like embedders (pi-web-ui class UI, rpiv Proxy UI) and an extension handler
 * that actually calls ctx.ui during session_start.
 */

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
});
