// What pi needs from djs that the djs package does not give yet (djs issue 0295), each as one thin adapter, so the
// switch to the fixed package touches only this file and its call sites in djs.ts:
// (a) a thrown Error's name, message, and stack as data; (b) console arguments that are Errors as data;
// (c) a hook for reads of a missing namespace member; (d) frozen namespaces with enumerable members;
// (e) non-identifier aliases of namespace members (`tools["my-tool"]`); (g) a run that is done once its body
// settles, with still-open calls dropped; (h) an opt-out of the JSON boundary for the output and store functions.
import type { SandboxError } from "@earendil-works/djs";
import type { CodemodeError } from "./types.ts";

/**
 * The script error of a run that threw. A thrown Error crosses as an opaque reference until (a), so its name and
 * message come from djs's display text (`TypeError: boom`) and it has no stack yet; any other thrown value crosses
 * as data, and its display text is the message.
 */
export function scriptError(error: SandboxError): CodemodeError {
	const value = error.value as { name?: unknown; message?: unknown; stack?: unknown; ref?: unknown } | undefined;
	if (typeof value?.name === "string" && typeof value.message === "string") {
		const head = value.message === "" ? value.name : `${value.name}: ${value.message}`;
		const frames = typeof value.stack === "string" ? value.stack.trimEnd() : "";
		return { kind: "script", name: value.name, message: value.message, stack: frames ? `${head}\n${frames}` : head };
	}
	if (typeof value === "object" && value !== null && value.ref !== undefined) {
		const match = /^([A-Za-z_$][\w$]*): ([\s\S]*)$/.exec(error.message);
		if (match !== null) return { kind: "script", name: match[1], message: match[2], stack: error.message };
		return { kind: "script", name: error.message, message: "", stack: error.message };
	}
	return { kind: "script", message: error.message };
}

/**
 * One console argument as text: strings as they are, numbers in their string form (JSON would print NaN as null),
 * Errors as `Name: message` and their stack, everything else as JSON. Until (b), an Error reaches the host as the
 * string "[Error]".
 */
export function consoleText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (value instanceof Error) {
		const head = value.message ? `${value.name}: ${value.message}` : value.name;
		const frames =
			typeof value.stack === "string" ? value.stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
		return [head, ...frames].join("\n");
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * The TypeError message for reading member `member` of namespace `label`, which does not exist: close matches, or
 * the members when there are few, and `hint`. For the djs hook of (c), which is not wired until it exists; until then
 * such a read is `undefined` and calling it fails with djs's "not a function".
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
	if (close.length > 0)
		message += ` Did you mean ${close
			.slice(0, 5)
			.map((name) => `${label}.${name}`)
			.join(", ")}?`;
	else if (names.length <= 20) message += ` Available: ${names.join(", ")}.`;
	if (hint) message += ` ${hint}`;
	return `${message} Check for a member with "${member}" in ${label}.`;
}

/** The hint `tools` adds to {@link missingMemberMessage}. */
export const TOOLS_MISSING_HINT = "ALL_TOOLS lists every tool; searchTools(query) finds tools by topic.";
