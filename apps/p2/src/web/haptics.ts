// Haptic feedback, in p2's iOS app (p2-ios) only: through the Haptics plugin of the bridge Capacitor injects into the
// page. In a browser nothing happens (owner decision: no `navigator.vibrate` on Android for now).

/** The part of Capacitor's injected bridge (`window.Capacitor`) this file uses. */
type CapacitorBridge = {
	getPlatform?: () => string;
	nativePromise?: (plugin: string, method: string, options: Record<string, unknown>) => Promise<unknown>;
};

/** The iOS app's bridge, when the page runs there. */
function iosBridge(): CapacitorBridge | undefined {
	const bridge = (window as { Capacitor?: CapacitorBridge }).Capacitor;
	return bridge?.getPlatform?.() === "ios" ? bridge : undefined;
}

/** Calls a Haptics plugin method; an app built without the plugin answers with an error: nothing happens. */
const haptics = (bridge: CapacitorBridge, method: string, options: Record<string, unknown> = {}) =>
	void bridge.nativePromise?.("Haptics", method, options).catch(() => {});

/** A light tap: a message sent. */
export function lightTap(): void {
	const bridge = iosBridge();
	if (bridge) haptics(bridge, "impact", { style: "LIGHT" });
}

/** Whether the iOS selection generator is prepared (`selectionChanged` needs it). */
let selecting = false;
/**
 * A very slight tick, as a picker wheel's detent: another item turned to face the reader (the activity wheel). iOS's
 * selection feedback, as its picker wheels give.
 */
export function tick(): void {
	const bridge = iosBridge();
	if (!bridge) return;
	if (!selecting) {
		selecting = true;
		haptics(bridge, "selectionStart");
	}
	haptics(bridge, "selectionChanged");
}
