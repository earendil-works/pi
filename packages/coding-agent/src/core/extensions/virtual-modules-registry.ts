let extensionVirtualModules: Record<string, unknown> | undefined;

export function setExtensionVirtualModules(modules: Record<string, unknown>): void {
	extensionVirtualModules = modules;
}

export function getExtensionVirtualModules(): Record<string, unknown> | undefined {
	return extensionVirtualModules;
}
