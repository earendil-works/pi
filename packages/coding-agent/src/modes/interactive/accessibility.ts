export type ScreenReaderMode = "flat";

let screenReaderMode: ScreenReaderMode | undefined;

export function setScreenReaderMode(mode: ScreenReaderMode | undefined): void {
	screenReaderMode = mode;
}

export function getScreenReaderMode(): ScreenReaderMode | undefined {
	return screenReaderMode;
}

export function isFlatScreenReaderMode(): boolean {
	return screenReaderMode === "flat";
}

export function getSelectionPrefix(): string {
	return isFlatScreenReaderMode() ? "> " : "→ ";
}
