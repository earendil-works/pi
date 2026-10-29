// A Harness's registry over a Chord registry (Chord v2 slice 8 §5): the composed value of p3's extensions registry,
// read as Durable's `RegistryReader`.

import type { Context } from "@earendil-works/chord/context";
import type { RegistryValue } from "@earendil-works/chord/next";
import type { RegistryReader, RegistrySnapshot, ToolRegistration } from "./types.ts";

/**
 * A `RegistryReader` over a Chord registry value whose composition is a registry snapshot: `snapshot()` reads the
 * current composition (the last good one while `compose` fails), `subscribe` observes its compositions, its listener
 * called synchronously inside the Chord batch that composed (so it only wakes the scheduler; a Chord call there
 * throws `invalid/reentrant`). `context` is the observation's: aborting it detaches every listener.
 */
export function registryReader<Tool extends ToolRegistration = ToolRegistration>(
	value: RegistryValue<RegistrySnapshot<Tool>>,
	context: Context,
): RegistryReader<Tool> {
	return {
		snapshot: () => value.value,
		subscribe: (listener) => {
			const observation = value.observe(
				{
					advance: (call) => {
						// A failed composition keeps the last snapshot: nothing to reconsider.
						if (call.kind === "value") listener();
					},
					end: () => {},
				},
				context,
			);
			return () => observation.detach();
		},
	};
}
