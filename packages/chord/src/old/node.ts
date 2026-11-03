/** Node-only parts of Chord v1 (`@earendil-works/chord/old/node`): child host processes, their manager, and the facet module loader. */
export { nodeLoader } from "./loader.ts";
export {
	type ControlMessage,
	childControl,
	createHostManager,
	type Driver,
	type Exit,
	type ForkDriverOptions,
	forkDriver,
	type HostManager,
	type HostManagerOptions,
	type Instance,
	type Liveness,
	processLock,
} from "./manager.ts";
