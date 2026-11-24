// When the barge-in detector listens (the engine's rule, apart so it can be tested without a browser).
//
// Barge-in listens only while the agent's speech actually plays: then the microphone is buffered, and sound the
// playback does not explain streams the speaker to the room. While the agent only works (nothing plays) the
// microphone streams as usual. In both cases only words the room recognizes interrupt the agent (interruption.ts).
import type { BargeInPhase } from "./barge-in.ts";

/** The phase pibot's detector is given: "speaking" only while speech plays, so it listens for barge-in only then. */
export function bargeInPhase(state: { hearing: boolean; playing: boolean }): BargeInPhase {
	if (state.hearing) return "hearing";
	return state.playing ? "speaking" : "listening";
}

/** An audio output as `enumerateDevices` lists it (its label is readable once the microphone is allowed). */
export type AudioOutput = { readonly kind: string; readonly deviceId: string; readonly label: string };

/** Output labels that are worn: no speaker the microphone can hear. */
const WORN = /head ?phones?|ear ?phones?|headset|ear ?buds?|airpods|in-ear|kopfh[oö]rer/i;

/**
 * Whether the microphone should run with the browser's echo canceller, for the outputs listed (the playback uses the
 * default one: Chrome's `default` entry, else the first). Off for headphones and earphones: there is no echo to
 * cancel, and Chrome's desktop canceller suppresses the speaker's own voice while the agent's speech plays, so talking
 * over it only worked close to the microphone. On for speakers and whenever the output is unknown (no labels yet, a
 * generic name): the barge-in detector's residual check then still sees through what is left of the echo.
 */
export function echoCancellationFor(devices: readonly AudioOutput[]): boolean {
	const outputs = devices.filter((device) => device.kind === "audiooutput");
	const used = outputs.find((device) => device.deviceId === "default") ?? outputs[0];
	return !(used && WORN.test(used.label));
}
