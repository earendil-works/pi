import { getNativePlatformHelper, type ModifierKey } from "./native-platform.ts";

export type { ModifierKey } from "./native-platform.ts";

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = getNativePlatformHelper();
	if (!helper?.isModifierPressed) return false;
	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}
