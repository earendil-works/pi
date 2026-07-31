import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SelectorOwnership } from "../src/modes/interactive/selector-ownership.ts";

describe("InteractiveMode selector ownership", () => {
	it("replaces the previous selector and disposes it once", () => {
		const first = new Container();
		const second = new Container();
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const mount = vi.fn();
		const restore = vi.fn();
		const ownership = new SelectorOwnership(mount, restore);
		let firstDone!: () => void;
		let secondDone!: () => void;

		expect(
			ownership.show((done) => {
				firstDone = done;
				return { component: first, focus: first, dispose: firstDispose };
			}),
		).toBe(true);
		expect(
			ownership.show((done) => {
				secondDone = done;
				return { component: second, focus: second, dispose: secondDispose };
			}),
		).toBe(true);

		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(mount).toHaveBeenLastCalledWith(second, second);

		firstDone();
		secondDone();
		secondDone();
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it("does not replace the current selector when the factory finishes synchronously", () => {
		const active = new Container();
		const canceled = new Container();
		const activeDispose = vi.fn();
		const canceledDispose = vi.fn();
		const mount = vi.fn();
		const restore = vi.fn();
		const ownership = new SelectorOwnership(mount, restore);
		let activeDone!: () => void;

		expect(
			ownership.show((done) => {
				activeDone = done;
				return { component: active, focus: active, dispose: activeDispose };
			}),
		).toBe(true);
		expect(
			ownership.show((done) => {
				done();
				return { component: canceled, focus: canceled, dispose: canceledDispose };
			}),
		).toBe(false);

		expect(activeDispose).not.toHaveBeenCalled();
		expect(canceledDispose).toHaveBeenCalledTimes(1);
		expect(mount).toHaveBeenCalledTimes(1);
		expect(mount).toHaveBeenCalledWith(active, active);
		expect(restore).not.toHaveBeenCalled();

		activeDone();
		expect(activeDispose).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledTimes(1);
	});

	it("leaves the editor in place when a synchronously completed first selector is returned", () => {
		const mount = vi.fn();
		const restore = vi.fn();
		const dispose = vi.fn();
		const ownership = new SelectorOwnership(mount, restore);
		const component = new Container();

		expect(
			ownership.show((done) => {
				done();
				return { component, focus: component, dispose };
			}),
		).toBe(false);

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(mount).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();
	});

	it("ignores a stale done callback after a newer selector is shown", () => {
		const first = new Container();
		const second = new Container();
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const mount = vi.fn();
		const restore = vi.fn();
		const ownership = new SelectorOwnership(mount, restore);
		let firstDone!: () => void;
		let secondDone!: () => void;

		ownership.show((done) => {
			firstDone = done;
			return { component: first, focus: first, dispose: firstDispose };
		});
		ownership.show((done) => {
			secondDone = done;
			return { component: second, focus: second, dispose: secondDispose };
		});

		firstDone();
		expect(secondDispose).not.toHaveBeenCalled();
		expect(restore).not.toHaveBeenCalled();

		secondDone();
		expect(secondDispose).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenCalledTimes(1);
	});
});
