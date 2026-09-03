import type { Context } from "../context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type {
	LaneState as DurableLaneState,
	LaneConfiguration,
	OperationMeta,
	OperationState,
	Session,
	SessionReader,
} from "../session/types.ts";
import {
	branchTip,
	branchTipInventoryPrefix,
	laneConfig,
	laneState as laneStateValue,
	operationMeta,
	operationState,
	type StoredValue,
} from "../session/values.ts";
import type { LaneState } from "./types.ts";

function isSummaryState(state: OperationState): state is Extract<OperationState, { at: `summary.${string}` }> {
	return state.at.startsWith("summary.");
}

function stateMatchesIntent(intent: OperationMeta["intent"], state: OperationState): boolean {
	if (intent.kind === "compaction") return isSummaryState(state) && state.task.boundary.kind === "finish";
	if (intent.kind === "navigation") {
		if (state.at === "navigation.ready_to_commit") {
			return !intent.summarize && state.targetId === intent.targetId && state.label === intent.label;
		}
		return (
			intent.summarize &&
			isSummaryState(state) &&
			state.task.boundary.kind === "commit_navigation" &&
			state.task.boundary.targetId === intent.targetId &&
			state.task.boundary.label === intent.label &&
			state.task.customInstructions === intent.customInstructions
		);
	}
	return (
		state.at !== "navigation.ready_to_commit" &&
		(!isSummaryState(state) || state.task.boundary.kind === "resume_checkpoint")
	);
}

type LaneValues = {
	tip: StoredValue<string | null> | undefined;
	configuration: StoredValue<LaneConfiguration> | undefined;
	laneState: StoredValue<DurableLaneState> | undefined;
};

export type ClassifiedLaneStorage =
	| { kind: "absent" }
	| { kind: "branch"; tip: StoredValue<string | null> }
	| {
			kind: "lane";
			tip: StoredValue<string | null>;
			configuration: StoredValue<LaneConfiguration>;
			laneState: StoredValue<DurableLaneState>;
	  };

function classifyLaneStorage(lane: string, values: LaneValues): ClassifiedLaneStorage {
	const { tip, configuration, laneState } = values;
	if (tip === undefined && configuration === undefined && laneState === undefined) {
		return { kind: "absent" };
	}
	if (tip !== undefined && configuration === undefined && laneState === undefined) {
		return { kind: "branch", tip };
	}
	if (tip === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing branch.tip`);
	if (configuration === undefined)
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
	if (laneState === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);
	return { kind: "lane", tip, configuration, laneState };
}

export async function readLaneStorage(
	reader: SessionReader,
	lane: string,
	context: Context,
): Promise<ClassifiedLaneStorage> {
	const [tip, configuration, laneState] = await Promise.all([
		reader.getValue(branchTip(lane), context),
		reader.getValue(laneConfig(lane), context),
		reader.getValue(laneStateValue(lane), context),
	]);
	return classifyLaneStorage(lane, { tip, configuration, laneState });
}

/** Restore every complete configured AgentLane in one coherent Session read. */
export function restoreSession(session: Session, context: Context): Promise<Map<string, LaneState>> {
	return session.mutate(async (reader) => {
		const [tips, configurations, states] = await Promise.all([
			reader.scanValues(branchTipInventoryPrefix(), context),
			reader.scanValues(laneConfig(""), context),
			reader.scanValues(laneStateValue(""), context),
		]);
		const tipByLane = new Map(tips.map((value) => [value.address.key, value]));
		const configurationByLane = new Map(configurations.map((value) => [value.address.key, value]));
		const stateByLane = new Map(states.map((value) => [value.address.key, value]));
		const names = new Set([...tipByLane.keys(), ...configurationByLane.keys(), ...stateByLane.keys()]);
		const restored = new Map<string, LaneState>();
		for (const lane of names) {
			const stored = classifyLaneStorage(lane, {
				tip: tipByLane.get(lane),
				configuration: configurationByLane.get(lane),
				laneState: stateByLane.get(lane),
			});
			if (stored.kind !== "lane") continue;
			restored.set(lane, await restoreLaneState(reader, lane, stored, context));
		}
		return restored;
	}, context);
}

/** Restore one configured lane without starting work or interpreting its state. */
export function restoreLane(session: Session, lane: string, context: Context): Promise<LaneState> {
	return session.mutate(async (reader) => {
		const stored = await readLaneStorage(reader, lane, context);
		if (stored.kind === "absent") {
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing branch.tip`);
		}
		if (stored.kind === "branch") {
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
		}
		return restoreLaneState(reader, lane, stored, context);
	}, context);
}

export async function restoreLaneState(
	reader: SessionReader,
	lane: string,
	stored: Extract<ClassifiedLaneStorage, { kind: "lane" }>,
	context: Context,
): Promise<LaneState> {
	const operationId = stored.laneState.value.currentOperationId;
	let operation: LaneState["operation"] = null;
	if (operationId !== null) {
		const [meta, state] = await Promise.all([
			reader.getValue(operationMeta(operationId), context),
			reader.getValue(operationState(operationId), context),
		]);
		if (meta === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.meta`);
		if (state === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.state`);
		if (meta.value.operationId !== operationId) {
			throw new SessionInvariantError(
				`Operation ${operationId} metadata names operation ${JSON.stringify(meta.value.operationId)}`,
			);
		}
		if (meta.value.lane !== lane) {
			throw new SessionInvariantError(
				`Operation ${operationId} belongs to lane ${JSON.stringify(meta.value.lane)}, not ${JSON.stringify(lane)}`,
			);
		}
		if (!stateMatchesIntent(meta.value.intent, state.value)) {
			throw new SessionInvariantError(
				`Operation ${operationId} intent ${meta.value.intent.kind} does not match state ${state.value.at}`,
			);
		}
		operation = { meta: meta.value, state: state.value };
	}

	return {
		tipId: stored.tip.value,
		configuration: stored.configuration.value,
		inbox: stored.laneState.value.inbox,
		lastOperationId: stored.laneState.value.lastOperationId,
		operation,
	};
}
