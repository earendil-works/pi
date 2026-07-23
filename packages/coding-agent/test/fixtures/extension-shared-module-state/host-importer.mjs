export async function readTuiModuleOrigin() {
	const tui = await import("@mariozechner/pi-tui");
	return tui.moduleOrigin ?? "pi-host";
}
