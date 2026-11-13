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
