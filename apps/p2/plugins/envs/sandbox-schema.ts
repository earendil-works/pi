// What the sandbox launcher on a host prints (p2-sandbox.sh check, p2-sandbox.mjs status/start/stop): wire input that
// the manager checks before use.

import { bool, num, obj, str, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";

/** `p2-sandbox.sh check`: how Gondolin can run on the host and what it found. */
export const LauncherCheckSchema = obj(
	{
		runtime: union([literal("native"), literal("none")]),
		system: str(),
		arch: str(),
		kvm: bool(),
		kvmDevice: bool(),
		qemu: str(),
		node: str(),
	},
	{ open: true },
);

/** `status`, `start` and `stop`: the VM's state; a running one names its configuration's revision. */
export const LauncherStatusSchema = union([
	obj({ state: literal("stopped") }, { open: true }),
	obj({ state: literal("running"), startedAt: num(), revision: str(), cpus: num(), memoryMb: num() }, { open: true }),
]);
