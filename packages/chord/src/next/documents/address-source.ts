// Watchable document addresses (slice 6a §11; decision "One retirement mechanism"): the frames of a source that
// follows one address, a singleton's slot or one key of a keyed slot. A change arrives with its ops, a write over
// another base as a root replacement, a retirement as `[["r", initial()]]` with the `retired` flag, and a document
// created after a retirement in the same batch as one root replacement with the flag.

import type { Context } from "../../context/index.ts";
import type { Op, Prepared } from "../../delta/index.ts";
import { Source } from "../state/internal.ts";
import type { JsonObject } from "./definition.ts";
import type { Documents } from "./documents.ts";

const NO_OPS: readonly Op[] = [];

/** A source following one document address; `value` is the document's, or `initial()` while it is absent. */
export abstract class AddressSource extends Source {
	/** The documents of the object whose document this is (a member source asks whose source it follows). */
	abstract readonly owner: Documents;
	/** The ops of the current batch's frame, and whether the document was retired in it. */
	#ops = NO_OPS;
	#retired = false;

	abstract override get value(): JsonObject;

	deliver(context: Context): void {
		this.publish(this.value, this.#ops, this.#retired, context);
		this.#ops = NO_OPS;
		this.#retired = false;
	}

	/**
	 * A commit wrote the document, which read `before`: its ops, or a root replacement when the draft started from
	 * another base or the document was retired earlier in the batch.
	 */
	written(before: JsonObject, prepared: Prepared<JsonObject>): void {
		// The ops are kept for a frame, which only a watched source gets: an unwatched one keeps none.
		if (this.watched) this.#ops = prepared.base === before && !this.#retired ? prepared.ops : [["r", prepared.value]];
		this.changed();
	}

	/** The document was retired: it reads `initial` again, and the frame says so. */
	retired(initial: JsonObject): void {
		// Reset by the frame, which only a watched source gets.
		if (this.watched) {
			this.#ops = [["r", initial]];
			this.#retired = true;
		}
		this.changed();
		this.retiredInBatch();
	}

	/** The value changed outside a commit (a migration, a load): a root replacement. */
	replaced(): void {
		if (this.watched) this.#ops = [["r", this.value]];
		this.changed();
	}
}
