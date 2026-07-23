export const moduleOrigin = "private-copy";

let active = false;

export class KeybindingsManager {
	constructor(_definitions, userBindings = { "app.tools.expand": "private" }) {
		this.userBindings = userBindings;
	}

	getKeys(keybinding) {
		const keys = this.userBindings[keybinding];
		return keys === undefined ? [] : Array.isArray(keys) ? [...keys] : [keys];
	}

	setUserBindings(userBindings) {
		this.userBindings = { ...userBindings };
	}
}

let keybindings = new KeybindingsManager({});

export function getKeybindings() {
	return keybindings;
}

export function setKeybindings(nextKeybindings) {
	keybindings = nextKeybindings;
}

export function isKittyProtocolActive() {
	return active;
}

export function setKittyProtocolActive(value) {
	active = value;
}
