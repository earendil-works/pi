import type { Context } from "@earendil-works/chord";
import type {
	AnyToolDeclaration,
	ContextEdit,
	CoreTx,
	Entry,
	HookInfo,
	HookResult,
	Id,
	JsonValue,
	RewindableState,
	Runtime,
	Stored,
	SystemMessage,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Sections (pico §12.1). A section is a stable key plus a pure renderer. Only
// keys, payloads and rendered text are stored; never renderers.
// ---------------------------------------------------------------------------

export interface SystemSection<T extends JsonValue = JsonValue> {
	readonly key: string;
	render(value: T): string;
}
export function defineSystemSection<T extends JsonValue>(definition: {
	key: string;
	render(value: T): string;
}): SystemSection<T> {
	return Object.freeze(definition);
}

export type EnvironmentInfo = { cwd: string };
export type SkillInfo = { name: string; description: string };
export const systemSections = {
	identity: defineSystemSection<string>({ key: "identity", render: (v) => v }),
	environment: defineSystemSection<EnvironmentInfo>({
		key: "environment",
		render: (v) => `Working directory: ${v.cwd}`,
	}),
	skills: defineSystemSection<SkillInfo[]>({
		key: "skills",
		render: (v) => v.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
	}),
} as const;

/** Section seed for a new conversation (§8.1): set with a checked pair, or remove an inherited key. */
export type SectionSeed = { key: string; value: JsonValue } | { key: string; remove: true };
export const sectionSeed = <T extends JsonValue>(section: SystemSection<T>, value: T): SectionSeed => ({
	key: section.key,
	value,
});
export const removeSection = (key: string): SectionSeed => ({ key, remove: true });

// ---------------------------------------------------------------------------
// The managed entry (§12.3)
// ---------------------------------------------------------------------------

export type SectionRecord =
	| { key: string; action: "set"; value: JsonValue; rendered: string }
	| { key: string; action: "remove" };
export type SystemEntryData = { baseline?: true; sections: SectionRecord[] };
/** A metadata-only delta has `model: []`. */
export type SystemEntry = Entry & { kind: "pi.system"; model: [] | [Stored<SystemMessage>]; data: SystemEntryData };

// ---------------------------------------------------------------------------
// Canonical state (§12.4): fold the fork-visible managed entries from the
// newest baseline forward. Uses the kind scan; never depends on heads or edits.
// ---------------------------------------------------------------------------

type SectionState = { value: JsonValue; rendered: string };
export type Canonical = Map<string, SectionState>; // insertion order is canonical order

export async function foldCanonical(
	reads: Pick<CoreTx, "scanEntries">,
	conversationId: Id,
): Promise<{ canonical: Canonical; newestManaged: Id | null; newestBaseline: Id | null }> {
	const managed: SystemEntry[] = [];
	let before: Id | undefined;
	let baseline: Id | null = null;
	scan: for (;;) {
		const page = await reads.scanEntries({
			conversationId,
			kind: "pi.system",
			limit: 64,
			...(before === undefined ? {} : { before }),
		});
		for (const e of page) {
			managed.push(e as SystemEntry);
			if ((e as SystemEntry).data.baseline) {
				baseline = e.id;
				break scan;
			}
		}
		if (page.length < 64) break;
		before = page[page.length - 1]!.id;
	}
	managed.reverse();
	const canonical: Canonical = new Map();
	for (const e of managed)
		for (const r of e.data.sections)
			r.action === "remove"
				? canonical.delete(r.key)
				: canonical.set(r.key, { value: r.value, rendered: r.rendered });
	return { canonical, newestManaged: managed[managed.length - 1]?.id ?? null, newestBaseline: baseline };
}

// ---------------------------------------------------------------------------
// Draft (§12.2): what `systemInstructions` handlers edit.
// ---------------------------------------------------------------------------

export interface SystemSectionDraft {
	get<T extends JsonValue>(section: SystemSection<T>): T | undefined; // owned copy
	set<T extends JsonValue>(section: SystemSection<T>, value: T): void; // existing key keeps position; new key appends
	delete(section: { key: string }): void;
	wrap<T extends JsonValue>(section: SystemSection<T>, transform: (rendered: string) => string): void; // preparation-local
}

class Draft implements SystemSectionDraft {
	values = new Map<string, JsonValue>();
	wrappers = new Map<string, ((r: string) => string)[]>();
	touched = new Set<string>();
	constructor(seed: Canonical) {
		for (const [k, s] of seed) this.values.set(k, s.value);
	}
	get<T extends JsonValue>(section: SystemSection<T>) {
		const v = this.values.get(section.key);
		return v === undefined ? undefined : (structuredClone(v) as T);
	}
	set<T extends JsonValue>(section: SystemSection<T>, value: T) {
		this.values.set(section.key, value);
		this.touched.add(section.key);
	}
	delete(section: { key: string }) {
		this.values.delete(section.key);
		this.wrappers.delete(section.key);
		this.touched.add(section.key);
	}
	wrap<T extends JsonValue>(section: SystemSection<T>, transform: (r: string) => string) {
		(this.wrappers.get(section.key) ?? this.wrappers.set(section.key, []).get(section.key)!).push(transform);
		this.touched.add(section.key);
	}
	snapshot() {
		return {
			values: new Map(this.values),
			wrappers: new Map([...this.wrappers].map(([k, v]) => [k, [...v]])),
			touched: new Set(this.touched),
		};
	}
	restore(s: ReturnType<Draft["snapshot"]>) {
		this.values = s.values;
		this.wrappers = s.wrappers;
		this.touched = s.touched;
	}
}

/** Render touched sections (wrappers apply after rendering, in registration order); untouched keep their stored text. */
function freeze(draft: Draft, canonical: Canonical, registry: ReadonlyMap<string, SystemSection>): Canonical {
	const desired: Canonical = new Map();
	for (const [key, value] of draft.values) {
		if (!draft.touched.has(key)) {
			const prev = canonical.get(key);
			if (prev) desired.set(key, prev);
			continue;
		}
		const def = registry.get(key);
		if (def === undefined) continue; // unregistered: cannot re-render; treated as removed
		let rendered = (def as SystemSection).render(value);
		for (const w of draft.wrappers.get(key) ?? []) rendered = w(rendered);
		desired.set(key, { value, rendered });
	}
	return desired;
}

// ---------------------------------------------------------------------------
// Preparation (§12.5)
// ---------------------------------------------------------------------------

export interface SectionRegistry {
	readonly map: ReadonlyMap<string, SystemSection>;
	readonly revision: number;
}
export interface ToolRegistry {
	readonly map: ReadonlyMap<string, AnyToolDeclaration>;
	readonly revision: number;
}

/** Snapshot S. Compared field by field before the `prepared` commit. */
export interface PreparationSnapshot {
	newestManaged: Id | null;
	newestBaseline: Id | null;
	newestHead: Id | null;
	settings: { model?: JsonValue; thinkingLevel: JsonValue; selectedTools: string[]; profile: JsonValue };
	sectionsRev: number;
	toolsRev: number;
}
export const sameSnapshot = (a: PreparationSnapshot, b: PreparationSnapshot) => JSON.stringify(a) === JSON.stringify(b);

export async function takeSnapshot(
	tx: Pick<CoreTx, "scanEntries" | "newestEntry" | "snapshot" | "conversation">,
	conversationId: Id,
	sections: SectionRegistry,
	tools: ToolRegistry,
): Promise<{ snapshot: PreparationSnapshot; canonical: Canonical; seed: readonly SectionSeed[] | undefined }> {
	const { canonical, newestManaged, newestBaseline } = await foldCanonical(tx, conversationId);
	const head = await tx.newestEntry(conversationId, { withHead: true });
	const r = tx.snapshot({ doc: "rewindable", conversationId }); // a plain copy: the snapshot outlives this transaction
	const conv = await tx.conversation(conversationId);
	return {
		snapshot: {
			newestManaged,
			newestBaseline,
			newestHead: head?.id ?? null,
			settings: {
				...(r.model === undefined ? {} : { model: r.model }),
				thinkingLevel: r.thinkingLevel,
				selectedTools: [...r.selectedTools],
				profile: r.profile,
			},
			sectionsRev: sections.revision,
			toolsRev: tools.revision,
		},
		canonical,
		seed: newestManaged === null ? conv?.sections : undefined, // §8.1: the seed applies while there is no local managed entry
	};
}

export interface SystemInstructionsHooks {
	/** Edit the draft; optionally override the tool loadout (last override wins). A throwing handler's edits are rolled back. */
	systemInstructions(
		input: {
			sections: SystemSectionDraft;
			config: PreparationSnapshot["settings"];
			tools: readonly AnyToolDeclaration[];
		},
		info: HookInfo,
		ctx: Context,
	): HookResult<{ tools?: readonly AnyToolDeclaration[] }>;
}

/** Off the line: seed the draft, run handlers, freeze. */
export async function prepareDraft(
	rt: Pick<Runtime<SystemInstructionsHooks>, "hooks" | "tools">,
	sections: SectionRegistry,
	canonical: Canonical,
	seed: readonly SectionSeed[] | undefined,
	settings: PreparationSnapshot["settings"],
	onReport: (m: string) => void,
	ctx: Context,
): Promise<{ desired: Canonical; tools: readonly AnyToolDeclaration[] }> {
	const draft = new Draft(canonical);
	for (const s of seed ?? [])
		"remove" in s ? draft.delete({ key: s.key }) : draft.set({ key: s.key, render: () => "" }, s.value);

	const defaultTools: AnyToolDeclaration[] = [];
	for (const name of settings.selectedTools) {
		const t = rt.tools.get(name);
		t ? defaultTools.push(t) : onReport(`selected tool ${name} is not registered`);
	}
	let tools: readonly AnyToolDeclaration[] = defaultTools;
	for (const binding of rt.hooks.handlers()) {
		const before = draft.snapshot();
		try {
			const out = await binding.handlers.systemInstructions?.(
				{ sections: draft, config: settings, tools: defaultTools },
				binding.api,
				ctx,
			);
			if (out?.tools) tools = out.tools;
		} catch (error) {
			if (ctx.abortSignal?.aborted) throw error;
			draft.restore(before); // collect / skip: this handler's edits are rolled back
			onReport(String(error));
		}
	}
	return { desired: freeze(draft, canonical, sections.map), tools };
}

/** On the line, in the `prepared` commit: diff desired against canonical; baseline if a head intervened. */
export async function planManagedEntry(
	tx: Pick<CoreTx, "context">,
	conversationId: Id,
	snapshot: PreparationSnapshot,
	canonical: Canonical,
	desired: Canonical,
	tools: readonly AnyToolDeclaration[],
	now: number,
): Promise<{ data: SystemEntryData; model: [] | [Stored<SystemMessage>]; edits?: ContextEdit[] } | undefined> {
	// §12.4: no managed history at all → first preparation appends a full baseline; and a usable
	// baseline must follow the newest head.
	const needBaseline =
		snapshot.newestManaged === null ||
		(snapshot.newestHead !== null &&
			(snapshot.newestBaseline === null || snapshot.newestHead > snapshot.newestBaseline));
	const toolOf = (t: AnyToolDeclaration) => ({
		name: t.name,
		description: t.description,
		parameters: structuredClone(t.parameters) as Stored<SystemMessage>["toolsAdded"] extends (infer X)[] | undefined
			? X extends { parameters: infer PP }
				? PP
				: never
			: never,
	});

	// Previous effective tools: those declared by the newest managed entry chain (we recompute from canonical's owner: the tail message).
	const { messages } = await tx.context(conversationId);
	const previous = new Map<string, { name: string }>();
	for (const m of messages)
		if (m.role === "system") {
			for (const t of (m as SystemMessage).toolsRemoved ?? []) previous.delete(t.name);
			for (const t of (m as SystemMessage).toolsAdded ?? []) previous.set(t.name, t);
		}

	if (needBaseline) {
		const sections: SectionRecord[] = [...desired].map(([key, s]) => ({
			key,
			action: "set",
			value: s.value,
			rendered: s.rendered,
		}));
		const content = sections.map((s) => (s.action === "set" ? `## ${s.key}\n${s.rendered}` : "")).join("\n\n");
		const { entries } = await tx.context(conversationId);
		const edits: ContextEdit[] = entries
			.filter((e: Entry) => e.kind === "pi.system" && e.id > (snapshot.newestHead ?? 0))
			.map((e: Entry) => ({ target: e.id, action: "omit" as const }));
		const message = {
			role: "system",
			content,
			toolsAdded: tools.map(toolOf),
			timestamp: now,
		} as Stored<SystemMessage>;
		return { data: { baseline: true, sections }, model: [message], ...(edits.length ? { edits } : {}) };
	}

	const changed: SectionRecord[] = [];
	for (const [key, s] of desired) {
		const prev = canonical.get(key);
		if (!prev || prev.rendered !== s.rendered || JSON.stringify(prev.value) !== JSON.stringify(s.value))
			changed.push({ key, action: "set", value: s.value, rendered: s.rendered });
	}
	for (const key of canonical.keys()) if (!desired.has(key)) changed.push({ key, action: "remove" });
	const added = tools.filter((t) => !previous.has(t.name));
	const removed = [...previous.values()].filter((p) => !tools.some((t) => t.name === p.name));
	if (changed.length === 0 && added.length === 0 && removed.length === 0) return undefined;

	const renderChanged = changed.some((s) => s.action === "remove" || canonical.get(s.key)?.rendered !== s.rendered);
	if (!renderChanged && added.length === 0 && removed.length === 0) return { data: { sections: changed }, model: [] }; // metadata-only delta
	const content = changed
		.map((s) =>
			s.action === "set"
				? `The ${s.key} section now reads:\n${s.rendered}`
				: `The ${s.key} section no longer applies.`,
		)
		.join("\n\n");
	const message = {
		role: "system",
		content,
		...(added.length ? { toolsAdded: added.map(toolOf) } : {}),
		...(removed.length ? { toolsRemoved: removed } : {}),
		timestamp: now,
	} as Stored<SystemMessage>;
	return { data: { sections: changed }, model: [message] };
}

/** Tools effective in a projected request: fold toolsAdded/toolsRemoved across its SystemMessages. */
export function effectiveTools(messages: readonly { role: string }[]): { name: string }[] {
	const tools = new Map<string, { name: string }>();
	for (const m of messages)
		if (m.role === "system") {
			for (const t of (m as SystemMessage).toolsRemoved ?? []) tools.delete(t.name);
			for (const t of (m as SystemMessage).toolsAdded ?? []) tools.set(t.name, t);
		}
	return [...tools.values()];
}

export type { RewindableState, Runtime };
