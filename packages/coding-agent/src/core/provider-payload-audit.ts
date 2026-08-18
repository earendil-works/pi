import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { getLatestCompactionEntry, type SessionManager, sessionEntryToContextMessages } from "./session-manager.ts";

export const PROVIDER_PAYLOAD_AUDIT_CUSTOM_TYPE = "provider-payload-audit";

interface PayloadSectionSnapshot {
	key: string;
	bytes: number;
	sha256: string;
	itemSha256?: string[];
}

interface PayloadSnapshot {
	bytes: number;
	sha256: string;
	sections: PayloadSectionSnapshot[];
}

interface ProviderPayloadLineage {
	payload: PayloadSnapshot;
	contextEntryIds: string[];
	latestCompactionEntryId?: string;
}

interface SequenceContinuity {
	change: "initial" | "unchanged" | "appended" | "rewritten";
	previousCount: number;
	currentCount: number;
	commonPrefixCount: number;
}

interface SectionContinuity {
	key: string;
	change: "added" | "removed" | "unchanged" | "appended" | "rewritten";
	previousBytes?: number;
	currentBytes?: number;
	commonPrefixItems?: number;
}

export interface ProviderPayloadAuditRecord {
	version: 1;
	requestIndex: number;
	provider: string;
	modelId: string;
	api: string;
	contextKey: string;
	classification:
		| "initial-context"
		| "new-model-context"
		| "linear-append-or-retry"
		| "linear-prefix-break"
		| "explicit-compaction"
		| "explicit-session-path-transition";
	payloadPrefixBroken: boolean;
	payload: PayloadSnapshot;
	sectionContinuity: SectionContinuity[];
	sectionOrder: SequenceContinuity;
	sessionContext: SequenceContinuity;
	latestCompactionEntryId?: string;
}

function jsonBytes(value: unknown): Buffer | undefined {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : Buffer.from(json);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const DIRECT_CONTEXT_SECTION_KEYS = new Set([
	"system",
	"system_instruction",
	"systemInstruction",
	"instructions",
	"messages",
	"input",
	"contents",
	"tools",
	"toolConfig",
	"tool_config",
]);
const NESTED_CONTEXT_SECTION_KEYS = new Map([
	["config", new Set(["systemInstruction", "tools", "toolConfig"])],
	["context", new Set(["systemPrompt", "messages", "tools"])],
]);
const LINEAR_APPEND_SECTION_KEYS = new Set(["messages", "input", "contents", "context.messages"]);

function addSection(sections: PayloadSectionSnapshot[], key: string, value: unknown): void {
	const bytes = jsonBytes(value);
	if (!bytes) return;
	sections.push({
		key,
		bytes: bytes.byteLength,
		sha256: sha256(bytes),
		itemSha256: Array.isArray(value)
			? value.map((item) => sha256(jsonBytes(item) ?? Buffer.from("null")))
			: undefined,
	});
}

function snapshotPayload(payload: unknown): PayloadSnapshot {
	const wholeBytes = jsonBytes(payload) ?? Buffer.from("null");
	const sections: PayloadSectionSnapshot[] = [];

	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		for (const [key, value] of Object.entries(payload)) {
			if (DIRECT_CONTEXT_SECTION_KEYS.has(key)) {
				addSection(sections, key, value);
				continue;
			}
			const nestedKeys = NESTED_CONTEXT_SECTION_KEYS.get(key);
			if (nestedKeys && typeof value === "object" && value !== null && !Array.isArray(value)) {
				for (const [nestedKey, nestedValue] of Object.entries(value)) {
					if (nestedKeys.has(nestedKey)) addSection(sections, `${key}.${nestedKey}`, nestedValue);
				}
			}
		}
		if (sections.length === 0) addSection(sections, "$payload", payload);
	} else {
		addSection(sections, "$payload", payload);
	}

	return { bytes: wholeBytes.byteLength, sha256: sha256(wholeBytes), sections };
}

function sequenceContinuity(previous: readonly string[] | undefined, current: readonly string[]): SequenceContinuity {
	if (!previous) {
		return {
			change: "initial",
			previousCount: 0,
			currentCount: current.length,
			commonPrefixCount: 0,
		};
	}

	let commonPrefixCount = 0;
	while (
		commonPrefixCount < previous.length &&
		commonPrefixCount < current.length &&
		previous[commonPrefixCount] === current[commonPrefixCount]
	) {
		commonPrefixCount++;
	}
	const change =
		commonPrefixCount === previous.length && commonPrefixCount === current.length
			? "unchanged"
			: commonPrefixCount === previous.length
				? "appended"
				: "rewritten";
	return {
		change,
		previousCount: previous.length,
		currentCount: current.length,
		commonPrefixCount,
	};
}

function compareSections(
	previous: readonly PayloadSectionSnapshot[] | undefined,
	current: readonly PayloadSectionSnapshot[],
): SectionContinuity[] {
	if (!previous) {
		return current.map((section) => ({ key: section.key, change: "added", currentBytes: section.bytes }));
	}

	const previousByKey = new Map(previous.map((section) => [section.key, section]));
	const currentByKey = new Map(current.map((section) => [section.key, section]));
	const result: SectionContinuity[] = [];

	for (const previousSection of previous) {
		const currentSection = currentByKey.get(previousSection.key);
		if (!currentSection) {
			result.push({ key: previousSection.key, change: "removed", previousBytes: previousSection.bytes });
			continue;
		}
		if (previousSection.sha256 === currentSection.sha256) {
			result.push({
				key: previousSection.key,
				change: "unchanged",
				previousBytes: previousSection.bytes,
				currentBytes: currentSection.bytes,
			});
			continue;
		}

		if (previousSection.itemSha256 && currentSection.itemSha256) {
			const continuity = sequenceContinuity(previousSection.itemSha256, currentSection.itemSha256);
			result.push({
				key: previousSection.key,
				change: continuity.change === "appended" ? "appended" : "rewritten",
				previousBytes: previousSection.bytes,
				currentBytes: currentSection.bytes,
				commonPrefixItems: continuity.commonPrefixCount,
			});
			continue;
		}

		result.push({
			key: previousSection.key,
			change: "rewritten",
			previousBytes: previousSection.bytes,
			currentBytes: currentSection.bytes,
		});
	}

	for (const currentSection of current) {
		if (!previousByKey.has(currentSection.key)) {
			result.push({ key: currentSection.key, change: "added", currentBytes: currentSection.bytes });
		}
	}
	return result;
}

function contextKey(model: Model<any>): string {
	return `${model.provider}\u0000${model.id}\u0000${model.api}`;
}

function environmentEnablesAudit(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Records hashes and sequence-prefix comparisons for the final payload returned
 * by before_provider_request handlers. It never mutates or retains the payload.
 */
export class ProviderPayloadAudit {
	private readonly previousByContext = new Map<string, ProviderPayloadLineage>();
	private readonly sessionManager: SessionManager;
	private readonly enabled: boolean;
	private lastContextKey: string | undefined;
	private requestIndex = 0;

	constructor(
		sessionManager: SessionManager,
		enabled = environmentEnablesAudit(process.env.PI_PROVIDER_PAYLOAD_AUDIT),
	) {
		this.sessionManager = sessionManager;
		this.enabled = enabled;
	}

	record(payload: unknown, model: Model<any>): void {
		if (!this.enabled) return;

		const key = contextKey(model);
		const previous = this.previousByContext.get(key);
		const payloadSnapshot = snapshotPayload(payload);
		const contextEntries = this.sessionManager
			.buildContextEntries()
			.filter((entry) => sessionEntryToContextMessages(entry).length > 0);
		const contextEntryIds = contextEntries.map((entry) => entry.id);
		const latestCompactionEntryId = getLatestCompactionEntry(this.sessionManager.getBranch())?.id;
		const sectionContinuity = compareSections(previous?.payload.sections, payloadSnapshot.sections);
		const sectionOrder = sequenceContinuity(
			previous?.payload.sections.map((section) => section.key),
			payloadSnapshot.sections.map((section) => section.key),
		);
		const sessionContext = sequenceContinuity(previous?.contextEntryIds, contextEntryIds);
		const payloadPrefixBroken =
			previous !== undefined &&
			(sectionOrder.change === "rewritten" ||
				sectionContinuity.some(
					(section) =>
						section.change === "added" ||
						section.change === "removed" ||
						section.change === "rewritten" ||
						(section.change === "appended" && !LINEAR_APPEND_SECTION_KEYS.has(section.key)),
				));

		let classification: ProviderPayloadAuditRecord["classification"];
		if (!previous) {
			classification = this.lastContextKey && this.lastContextKey !== key ? "new-model-context" : "initial-context";
		} else if (
			sessionContext.change === "rewritten" &&
			latestCompactionEntryId !== undefined &&
			latestCompactionEntryId !== previous.latestCompactionEntryId
		) {
			classification = "explicit-compaction";
		} else if (sessionContext.change === "rewritten") {
			classification = "explicit-session-path-transition";
		} else if (payloadPrefixBroken) {
			classification = "linear-prefix-break";
		} else {
			classification = "linear-append-or-retry";
		}

		const record: ProviderPayloadAuditRecord = {
			version: 1,
			requestIndex: ++this.requestIndex,
			provider: model.provider,
			modelId: model.id,
			api: model.api,
			contextKey: key,
			classification,
			payloadPrefixBroken,
			payload: payloadSnapshot,
			sectionContinuity,
			sectionOrder,
			sessionContext,
			latestCompactionEntryId,
		};

		this.sessionManager.appendCustomEntry(PROVIDER_PAYLOAD_AUDIT_CUSTOM_TYPE, record);
		this.previousByContext.set(key, { payload: payloadSnapshot, contextEntryIds, latestCompactionEntryId });
		this.lastContextKey = key;
	}
}
