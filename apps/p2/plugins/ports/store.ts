import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Subscribable } from "@p2/app/v1";
import { FORWARD_ID, type Forward, validateForwardName, validateForwardPort } from "./protocol.ts";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_FORWARDS = 50;

/**
 * The port forwards, kept in `forwards.json` of the data directory as
 * `{ "<id>": { "port", "name"?, "public"?, "session"? } }`.
 *
 * The owner manages them in the Ports sheet; a session's agent opens and closes them through the `ports` tool
 * (`session` names the session that opened one). The agent may change or close any forward; a session's forwards
 * close when it is archived.
 *
 * The server is the only reader and writer: the Radius relay client looks a forward up for every relayed request, so
 * the list lives in memory and every change is written through. A forward's ID is random and becomes part of its URL;
 * removing a forward and adding the same port again gives a new URL, so a removed forward's links stop working.
 */
export class Forwards {
	readonly #path: string;
	readonly #forwards: Map<string, Forward>;
	/** Writes run one at a time, each with the whole list as it is then. */
	#saving: Promise<void> = Promise.resolve();
	/** The brain's Radius origin: saved in radius.json, updated from relayed requests for its UI. */
	#radiusOrigin: string | null = null;
	readonly #listeners = new Set<() => void>();
	readonly events: Subscribable<void> = {
		subscribe: (listener: () => void) => {
			this.#listeners.add(listener);
			return () => this.#listeners.delete(listener);
		},
	};

	get radiusOrigin(): string | null {
		return this.#radiusOrigin;
	}

	set radiusOrigin(origin: string | null) {
		if (origin === this.#radiusOrigin) return;
		this.#radiusOrigin = origin;
		for (const listener of this.#listeners) listener();
	}

	private constructor(path: string, forwards: Map<string, Forward>) {
		this.#path = path;
		this.#forwards = forwards;
	}

	static async open(directory: string): Promise<Forwards> {
		const path = join(directory, "forwards.json");
		let text: string | undefined;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const forwards = new Map<string, Forward>();
		if (text !== undefined) {
			const value: unknown = JSON.parse(text);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid forwards.json");
			for (const [id, entry] of Object.entries(value)) {
				if (!FORWARD_ID.test(id) || !entry || typeof entry !== "object") throw new Error("Invalid forwards.json");
				const fields = entry as { port?: unknown; name?: unknown; public?: unknown; session?: unknown };
				const name = validateForwardName(fields.name);
				if (
					(fields.public !== undefined && typeof fields.public !== "boolean") ||
					(fields.session !== undefined && (typeof fields.session !== "string" || !fields.session))
				)
					throw new Error("Invalid forwards.json");
				forwards.set(id, {
					id,
					port: validateForwardPort(fields.port),
					...(name ? { name } : {}),
					...(fields.public ? { public: true } : {}),
					...(typeof fields.session === "string" ? { session: fields.session } : {}),
				});
			}
		}
		return new Forwards(path, forwards);
	}

	get(id: string): Forward | undefined {
		return this.#forwards.get(id);
	}

	list(): Forward[] {
		return [...this.#forwards.values()].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id));
	}

	/** `reserved`: ports that must never be forwarded, such as this server's own. */
	async add(
		port: number,
		name: string | undefined,
		reserved: readonly number[],
		options: { public?: boolean; session?: string } = {},
	): Promise<Forward> {
		validateForwardPort(port);
		if (reserved.includes(port)) throw new Error("This is Pi's own port; it is already reachable through Radius");
		if (this.#forwards.size >= MAX_FORWARDS) throw new Error(`At most ${MAX_FORWARDS} forwards`);
		const validName = validateForwardName(name);
		let id = "";
		do id = [...randomBytes(10)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
		while (this.#forwards.has(id));
		const forward = {
			id,
			port,
			...(validName ? { name: validName } : {}),
			...(options.public ? { public: true } : {}),
			...(options.session ? { session: options.session } : {}),
		};
		this.#forwards.set(id, forward);
		await this.#save();
		return forward;
	}

	/**
	 * The `ports` tool's open: one forward per port. A port that is already forwarded keeps its address and its opener,
	 * and takes the new name and visibility, whoever opened it.
	 */
	async openForSession(
		session: string,
		port: number,
		options: { name?: string; public?: boolean },
		reserved: readonly number[],
	): Promise<Forward> {
		validateForwardPort(port);
		const existing = [...this.#forwards.values()].find((forward) => forward.port === port);
		if (!existing) return this.add(port, options.name, reserved, { public: options.public, session });
		const name = options.name === undefined ? existing.name : validateForwardName(options.name);
		const open = options.public ?? existing.public ?? false;
		const updated = {
			id: existing.id,
			port,
			...(name ? { name } : {}),
			...(open ? { public: true } : {}),
			...(existing.session ? { session: existing.session } : {}),
		};
		this.#forwards.set(existing.id, updated);
		await this.#save();
		return updated;
	}

	/** The `ports` tool's close, whoever opened the forward; false when the port was not forwarded. */
	async closePort(port: number): Promise<boolean> {
		const existing = [...this.#forwards.values()].find((forward) => forward.port === port);
		if (!existing) return false;
		this.#forwards.delete(existing.id);
		await this.#save();
		return true;
	}

	/** Closes every forward a session opened, as when it is archived. */
	async closeSession(session: string): Promise<void> {
		let changed = false;
		for (const forward of [...this.#forwards.values()])
			if (forward.session === session) changed = this.#forwards.delete(forward.id) || changed;
		if (changed) await this.#save();
	}

	/** Public forwards are open to anyone with the link; private ones only to the owner. */
	async setPublic(id: string, open: boolean): Promise<void> {
		const forward = this.#forwards.get(id);
		if (!forward) throw new Error("Unknown forward");
		const { public: _previous, ...rest } = forward;
		this.#forwards.set(id, open ? { ...rest, public: true } : rest);
		await this.#save();
	}

	async remove(id: string): Promise<void> {
		if (!this.#forwards.delete(id)) throw new Error("Unknown forward");
		await this.#save();
	}

	#save(): Promise<void> {
		const write = async () => {
			const value = Object.fromEntries([...this.#forwards.values()].map(({ id, ...fields }) => [id, fields]));
			await writeFile(`${this.#path}.tmp`, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
			await rename(`${this.#path}.tmp`, this.#path);
			for (const listener of this.#listeners) listener();
		};
		const saving = this.#saving.then(write, write);
		this.#saving = saving.catch(() => {});
		return saving;
	}
}
