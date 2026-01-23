export type ApplyPatchOpType = "add" | "update" | "delete";

export interface ApplyPatchFileOp {
	type: ApplyPatchOpType;
	path: string;
	movedTo?: string;
}

export interface ApplyPatchParseResult {
	ops: ApplyPatchFileOp[];
	deletedPaths: string[];
}

const ADD_PREFIX = "*** Add File:";
const UPDATE_PREFIX = "*** Update File:";
const DELETE_PREFIX = "*** Delete File:";
const MOVE_PREFIX = "*** Move to:";

function extractPath(line: string, prefix: string): string | null {
	if (!line.startsWith(prefix)) {
		return null;
	}
	const value = line.slice(prefix.length).trim();
	return value.length > 0 ? value : null;
}

export function parseApplyPatchInput(input: string): ApplyPatchParseResult {
	const ops: ApplyPatchFileOp[] = [];
	const deletedSet = new Set<string>();
	let lastUpdateIndex: number | null = null;

	const lines = input.split(/\r?\n/);
	for (const line of lines) {
		const addPath = extractPath(line, ADD_PREFIX);
		if (addPath) {
			ops.push({ type: "add", path: addPath });
			lastUpdateIndex = null;
			continue;
		}

		const updatePath = extractPath(line, UPDATE_PREFIX);
		if (updatePath) {
			ops.push({ type: "update", path: updatePath });
			lastUpdateIndex = ops.length - 1;
			continue;
		}

		const movePath = extractPath(line, MOVE_PREFIX);
		if (movePath) {
			if (lastUpdateIndex !== null) {
				ops[lastUpdateIndex] = { ...ops[lastUpdateIndex], movedTo: movePath };
			}
			continue;
		}

		const deletePath = extractPath(line, DELETE_PREFIX);
		if (deletePath) {
			ops.push({ type: "delete", path: deletePath });
			deletedSet.add(deletePath);
			lastUpdateIndex = null;
		}
	}

	return {
		ops,
		deletedPaths: Array.from(deletedSet),
	};
}
