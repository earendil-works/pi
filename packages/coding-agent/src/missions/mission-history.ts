import type { MissionExperimentStatus, MissionLatestExperimentResult } from "./types.js";

const EXPERIMENT_STATUSES: MissionExperimentStatus[] = ["keep", "discard", "crash", "blocked"];

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseExperimentResult(record: Record<string, unknown>): MissionLatestExperimentResult | undefined {
	const status = record.status;
	if (typeof status !== "string" || !EXPERIMENT_STATUSES.includes(status as MissionExperimentStatus)) {
		return undefined;
	}

	const reason = typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason : undefined;
	return {
		status: status as MissionExperimentStatus,
		reason,
		raw: record,
	};
}

function isResumeResetBarrier(record: Record<string, unknown>): boolean {
	return record.type === "control" && record.kind === "resume-reset";
}

export interface ParsedMissionHistory {
	latestExperimentResult?: MissionLatestExperimentResult;
	optimizeStatusesSinceReset: MissionExperimentStatus[];
}

export function parseMissionHistory(experimentsText: string | undefined): ParsedMissionHistory {
	if (!experimentsText) {
		return { optimizeStatusesSinceReset: [] };
	}

	const optimizeStatusesSinceReset: MissionExperimentStatus[] = [];
	let latestExperimentResult: MissionLatestExperimentResult | undefined;

	for (const line of experimentsText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (!asRecord(parsed)) {
			continue;
		}

		if (isResumeResetBarrier(parsed)) {
			optimizeStatusesSinceReset.length = 0;
			latestExperimentResult = undefined;
			continue;
		}

		const experimentResult = parseExperimentResult(parsed);
		if (!experimentResult) {
			continue;
		}

		latestExperimentResult = experimentResult;
		optimizeStatusesSinceReset.push(experimentResult.status);
	}

	return {
		latestExperimentResult,
		optimizeStatusesSinceReset,
	};
}
