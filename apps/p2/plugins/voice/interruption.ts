// When the person talking interrupts the agent: only once the speech service heard real words. The barge-in
// detector (barge-in.ts) and the service's VAD may both take noise (windshield wipers, a door) for speech, so neither
// stops anything on its own:
//
// - A barge-in trigger while the agent's speech plays only opens a candidate: the microphone (from a second before)
//   streams to the room while the agent goes on speaking. No `speech_start` from the room within CANDIDATE_START_MS:
//   the candidate is dropped (`dropStream`) and the microphone goes back to being buffered.
// - Words decide: the first interim (or final) transcript with a real word (not empty, not a filler such as "um", not
//   the agent's own words picked up from the speaker) interrupts at once: the agent's speech is cut and its run is
//   stopped, as the Stop button would (in chat mode only when the words are for the agent, or a stop command; there
//   people talking with each other cut the agent's speech, never its work). This holds while the agent only works
//   too: the speaker no longer waits for the end of the utterance.
// - A final without such words is dropped: never sent as a message, and nothing was interrupted.
// - Utterances overlap on the wire: the next one's `speech_start` often arrives before the previous one's final (its
//   decode takes a moment; the service also splits speech at 30 s). So the state is kept per utterance, in order: a
//   final belongs to the oldest open one, interim transcripts to the newest. A final whose next utterance has already
//   started is held and sent joined with it: one dictation is one message, never stopping the run of its own first
//   half.
//
// A service without interim transcripts interrupts at the final (after the utterance), by the same rule.
import { isStopCommand } from "./speech-text.ts";
import { voiceMessage } from "./transcripts.ts";

/** What the engine knows when words arrive. */
export type InterruptionState = {
	/** The agent works (its run is live). */
	busy: boolean;
	/** The agent's speech is asked for or plays. */
	speaking: boolean;
	chatMode: boolean;
	agentName: string | undefined;
	/** What the agent said lately (its latest answers' text), to tell an echo from the speaker's words. */
	said: () => readonly string[];
};

export type InterruptionDeps = {
	state: () => InterruptionState;
	/** Cuts the agent's speech (for the room) and never reads the rest of the answers known so far. */
	cutSpeech: () => void;
	/** Stops the run (`PendingTranscripts.stopping`: sends wait for it, withdrawn messages go with the next one). */
	stopRun: () => void;
	/** Ends the candidate's stream: back to buffering, the room's VAD reset. */
	dropStream: () => void;
	log: (message: string) => void;
	now?: () => number;
};

/** How long a barge-in candidate may stream before the room reports speech; past it, it was noise. */
export const CANDIDATE_START_MS = 1500;

/** Words that are no message: hesitation and backchannel sounds, as Parakeet writes them for noise or breath. */
const FILLERS = new Set([
	"uh",
	"uhm",
	"um",
	"umm",
	"hm",
	"hmm",
	"mm",
	"mmm",
	"mhm",
	"mm-hmm",
	"uh-huh",
	"ah",
	"oh",
	"eh",
	"er",
	"erm",
	"huh",
	"ha",
]);

const wordsOf = (text: string): string[] =>
	(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter((word) => !FILLERS.has(word));

/** Whether a transcript holds a real word: one that is no filler, and longer than a letter unless it is a number. */
export function meaningful(text: string): boolean {
	return wordsOf(text).some((word) => word.length > 1 || /\p{N}/u.test(word));
}

/**
 * Whether `text` is the agent's speech heard back through the speaker: three words or more, every one of them among
 * the words the agent said. Shorter replies ("yes", "no, stop") are the speaker's, even when the agent used them.
 */
export function isEcho(text: string, said: readonly string[]): boolean {
	const words = wordsOf(text);
	if (words.length < 3) return false;
	const known = new Set(said.flatMap(wordsOf));
	return words.every((word) => known.has(word));
}

/** One utterance the room reported (`speech_start`) and has not finished (`final`): what it did already, once each. */
type Utterance = { candidate: boolean; cut: boolean; stopped: boolean };

export class Interruption {
	readonly #deps: InterruptionDeps;
	/** A barge-in trigger the room has not reported speech for yet: when it fired. */
	#candidate: { at: number } | undefined;
	/** Utterances started and not yet final, oldest first. */
	readonly #utterances: Utterance[] = [];
	/** Finals held for the utterance that followed them without a pause (with whether they stopped the run). */
	readonly #held: string[] = [];
	#heldStopped = false;

	constructor(deps: InterruptionDeps) {
		this.#deps = deps;
	}

	/** A candidate streams and waits for the room to hear speech: the microphone keeps streaming while the agent speaks. */
	get pending(): boolean {
		return this.#candidate !== undefined;
	}

	/** The barge-in detector fired: its stream starts, nothing is interrupted yet. */
	trigger(): void {
		if (this.#candidate) return;
		this.#candidate = { at: this.#now() };
		this.#deps.log("barge-in candidate: streaming, waiting for words");
	}

	/** The room heard speech start: a new utterance (the candidate's, if one waits). */
	speechStart(): void {
		this.#utterances.push({ candidate: this.#candidate !== undefined, cut: false, stopped: false });
		this.#candidate = undefined;
	}

	/** Called with each microphone frame: a candidate the room never heard as speech is dropped. */
	tick(): void {
		const candidate = this.#candidate;
		if (!candidate || this.#now() - candidate.at < CANDIDATE_START_MS) return;
		this.#candidate = undefined;
		this.#drop("no speech heard");
	}

	/** An interim transcript of the utterance in progress. */
	interim(text: string): void {
		const current = this.#utterances.at(-1);
		if (current) this.#consider(text, current);
	}

	/**
	 * The oldest open utterance's final transcript. `text`: what to send now, if anything (words, not the agent's own
	 * heard back; with the finals held for it); `stopped`: whether those utterances stopped the run. It interrupts first
	 * if its interim transcripts did not. Held when the next utterance already started.
	 */
	final(text: string): { text: string | undefined; stopped: boolean } {
		const utterance = this.#utterances.shift() ?? { candidate: false, cut: false, stopped: false };
		const words = meaningful(text) && (utterance.cut || utterance.stopped || !this.#echo(text, utterance));
		if (words) this.#consider(text, utterance);
		else if (utterance.candidate) this.#drop(text.trim() ? "no words, or the agent's own" : "nothing recognized");
		else if (text.trim()) this.#deps.log(`final dropped: no words (${text.trim().length} chars)`);
		if (words) {
			this.#held.push(text);
			this.#heldStopped ||= utterance.stopped;
		}
		// Still talking: what was said goes with what follows.
		if (this.#utterances.length > 0) {
			if (words) this.#deps.log("final held: the next utterance already started");
			return { text: undefined, stopped: false };
		}
		return this.#release();
	}

	/**
	 * Forgets the utterances in progress (the room's connection ended, the microphone was muted); held finals are
	 * returned to be sent.
	 */
	reset(): { text: string | undefined; stopped: boolean } {
		this.#candidate = undefined;
		this.#utterances.length = 0;
		return this.#release();
	}

	#release(): { text: string | undefined; stopped: boolean } {
		const text = this.#held.length > 0 ? this.#held.splice(0).join(" ") : undefined;
		const stopped = this.#heldStopped;
		this.#heldStopped = false;
		return { text, stopped };
	}

	#consider(text: string, utterance: Utterance): void {
		if (!meaningful(text) || (!utterance.cut && !utterance.stopped && this.#echo(text, utterance))) return;
		const state = this.#deps.state();
		const addressed = voiceMessage(text, state.chatMode, state.agentName).interrupts || isStopCommand(text);
		const cut = state.speaking && !utterance.cut;
		const stop = state.busy && addressed && !utterance.stopped && !this.#heldStopped;
		if (!cut && !stop) return;
		utterance.cut ||= cut;
		utterance.stopped ||= stop;
		this.#deps.log(
			`interrupted by speech: ${[cut && "speech cut", stop && "run stopped"].filter(Boolean).join(", ")}`,
		);
		if (cut) this.#deps.cutSpeech();
		if (stop) this.#deps.stopRun();
	}

	/** Words heard while the agent speaks (or from a barge-in candidate) that are all the agent's own. */
	#echo(text: string, utterance: Utterance): boolean {
		const state = this.#deps.state();
		return (state.speaking || utterance.candidate) && isEcho(text, state.said());
	}

	#drop(reason: string): void {
		this.#deps.log(`barge-in candidate dropped (${reason}); the agent goes on`);
		// An utterance in progress (or a new candidate) keeps the stream and the room's VAD.
		if (this.#utterances.length === 0 && !this.#candidate) this.#deps.dropStream();
	}

	#now(): number {
		return this.#deps.now?.() ?? Date.now();
	}
}
