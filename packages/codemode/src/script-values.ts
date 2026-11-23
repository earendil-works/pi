// How the host reads what scripts hand it: a thrown error, console arguments, values to turn into JSON, and the
// message for a read of a namespace member that does not exist.
import { Opaque, type SandboxError } from "@earendil-works/djs";
import type { CodemodeError } from "./types.ts";

/**
 * The script error of a run that threw: an Error with its name, message, and the VM's stack (`Name: message` and the
 * frames, as V8 prints it), any other thrown value with its display text as the message.
 */
export function scriptError(error: SandboxError): CodemodeError {
	const { value } = error;
	if (value instanceof Error)
		return { kind: "script", name: value.name, message: value.message, stack: errorText(value) };
	return { kind: "script", message: error.message };
}

/**
 * One console argument as text: strings as they are, numbers in their string form (JSON would print NaN as null),
 * Errors as `Name: message` and their stack, everything else as JSON.
 */
export function consoleText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (value instanceof Error) return errorText(value);
	try {
		return toJson(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * `JSON.stringify` of a value as the script handed it over plainly: functions and symbols (which cross as `Opaque`)
 * are left out as JSON leaves them out. Throws for what JSON cannot hold (a cycle, a BigInt).
 */
export function toJson(value: unknown): string | undefined {
	return JSON.stringify(value, (_key, item: unknown) => (item instanceof Opaque ? undefined : item));
}

/** An Error as V8 prints it: `Name: message` and the `    at ...` lines of its stack. */
function errorText(error: Error): string {
	const head = error.message === "" ? error.name : `${error.name}: ${error.message}`;
	const frames = typeof error.stack === "string" ? error.stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
	return [head, ...frames].join("\n");
}

/**
 * The TypeError message for reading member `member` of namespace `label`, which does not exist: close matches, or
 * the members when there are few, and `hint`.
 */
export function missingMemberMessage(label: string, member: string, names: readonly string[], hint?: string): string {
	const comparable = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
	const wanted = comparable(member);
	const exact = names.filter((name) => comparable(name) === wanted);
	const close =
		exact.length > 0
			? exact
			: names.filter(
					(name) => wanted !== "" && (comparable(name).includes(wanted) || wanted.includes(comparable(name))),
				);
	let message = `${label}.${member} does not exist.`;
	if (close.length > 0) {
		message += ` Did you mean ${close
			.slice(0, 5)
			.map((name) => `${label}.${name}`)
			.join(", ")}?`;
	} else if (names.length <= 20) message += ` Available: ${names.join(", ")}.`;
	if (hint) message += ` ${hint}`;
	return `${message} Check for a member with "${member}" in ${label}.`;
}
