import * as fs from "node:fs";
import * as path from "node:path";

/**
 * @typedef {"paper-audit"} TaskKind
 * @typedef {"queued" | "running" | "completed" | "failed" | "cancelled"} TaskState
 * @typedef {string} Stage
 *
 * @typedef {Object} TaskStatus
 * @property {string} id
 * @property {TaskKind} kind
 * @property {string} input
 * @property {TaskState} state
 * @property {Stage} stage
 * @property {number} progress
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string[]} artifacts
 * @property {string | null} error
 *
 * @typedef {Object} TaskRecord
 * @property {string} id
 * @property {string} dir
 * @property {TaskStatus} status
 *
 * @typedef {Object} TaskSummary
 * @property {string} id
 * @property {string} dir
 * @property {TaskState} state
 * @property {Stage} stage
 * @property {number} progress
 * @property {string} updatedAt
 * @property {string} input
 */

/** @param {string} cwd */
export function getTasksRoot(cwd) {
	return path.join(cwd, ".pi", "tasks");
}

/**
 * @param {string} cwd
 * @param {string} taskId
 */
export function getTaskDir(cwd, taskId) {
	return path.join(getTasksRoot(cwd), taskId);
}

/** @param {number} n */
function pad3(n) {
	return n.toString().padStart(3, "0");
}

/** @param {Date} [date] */
function todayStamp(date = new Date()) {
	const y = date.getUTCFullYear();
	const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const d = date.getUTCDate().toString().padStart(2, "0");
	return `${y}${m}${d}`;
}

function nowIso() {
	return new Date().toISOString();
}

/** @param {string} dir */
async function ensureDir(dir) {
	await fs.promises.mkdir(dir, { recursive: true });
}

/** @param {string} tasksRoot */
function generateTaskId(tasksRoot) {
	const stamp = todayStamp();
	let maxN = 0;
	if (fs.existsSync(tasksRoot)) {
		for (const name of fs.readdirSync(tasksRoot)) {
			const m = name.match(/^task-(\d{8})-(\d{3})$/);
			if (m && m[1] === stamp) {
				const n = Number.parseInt(m[2], 10);
				if (n > maxN) maxN = n;
			}
		}
	}
	return `task-${stamp}-${pad3(maxN + 1)}`;
}

/**
 * @param {string} filePath
 * @param {string} data
 */
async function atomicWriteFile(filePath, data) {
	const dir = path.dirname(filePath);
	await ensureDir(dir);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.promises.writeFile(tmp, data, "utf-8");
	await fs.promises.rename(tmp, filePath);
}

/**
 * @param {string} cwd
 * @param {TaskKind} kind
 * @param {string} input
 * @returns {Promise<TaskRecord>}
 */
export async function createTask(cwd, kind, input) {
	const tasksRoot = getTasksRoot(cwd);
	await ensureDir(tasksRoot);
	const id = generateTaskId(tasksRoot);
	const dir = getTaskDir(cwd, id);
	await ensureDir(dir);
	await ensureDir(path.join(dir, "notes"));

	/** @type {TaskStatus} */
	const status = {
		id,
		kind,
		input,
		state: "queued",
		stage: "init",
		progress: 0,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		artifacts: [],
		error: null,
	};
	await writeStatus(cwd, id, status);
	await appendLog(cwd, id, `created task for input=${input}`);
	return { id, dir, status };
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @returns {Promise<TaskStatus | undefined>}
 */
export async function readStatus(cwd, taskId) {
	const file = path.join(getTaskDir(cwd, taskId), "status.json");
	if (!fs.existsSync(file)) return undefined;
	const raw = await fs.promises.readFile(file, "utf-8");
	return JSON.parse(raw);
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {TaskStatus} status
 */
async function writeStatus(cwd, taskId, status) {
	const file = path.join(getTaskDir(cwd, taskId), "status.json");
	await atomicWriteFile(file, `${JSON.stringify(status, null, 2)}\n`);
}

/**
 * @typedef {Object} StatusPatch
 * @property {TaskState} [state]
 * @property {Stage} [stage]
 * @property {number} [progress]
 * @property {string | null} [error]
 * @property {string[]} [addArtifacts]
 */

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {StatusPatch} patch
 * @returns {Promise<TaskStatus>}
 */
export async function updateStatus(cwd, taskId, patch) {
	const current = await readStatus(cwd, taskId);
	if (!current) throw new Error(`Task not found: ${taskId}`);
	/** @type {TaskStatus} */
	const next = {
		...current,
		state: patch.state ?? current.state,
		stage: patch.stage ?? current.stage,
		progress: patch.progress ?? current.progress,
		error: patch.error === undefined ? current.error : patch.error,
		artifacts: patch.addArtifacts
			? Array.from(new Set([...current.artifacts, ...patch.addArtifacts]))
			: current.artifacts,
		updatedAt: nowIso(),
	};
	await writeStatus(cwd, taskId, next);
	return next;
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {string} message
 */
export async function appendLog(cwd, taskId, message) {
	const file = path.join(getTaskDir(cwd, taskId), "log.txt");
	await ensureDir(path.dirname(file));
	const line = `[${nowIso()}] ${message}\n`;
	await fs.promises.appendFile(file, line, "utf-8");
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {string} relativePath
 * @param {string | Buffer} contents
 */
export async function writeArtifact(cwd, taskId, relativePath, contents) {
	const dir = getTaskDir(cwd, taskId);
	const full = path.join(dir, relativePath);
	await ensureDir(path.dirname(full));
	if (typeof contents === "string") {
		await atomicWriteFile(full, contents);
	} else {
		const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
		await fs.promises.writeFile(tmp, contents);
		await fs.promises.rename(tmp, full);
	}
	await updateStatus(cwd, taskId, { addArtifacts: [relativePath] });
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
export async function readArtifact(cwd, taskId, relativePath) {
	const full = path.join(getTaskDir(cwd, taskId), relativePath);
	return fs.promises.readFile(full, "utf-8");
}

/**
 * @param {string} cwd
 * @param {string} taskId
 * @param {number} [lines]
 * @returns {Promise<string[]>}
 */
export async function readLogTail(cwd, taskId, lines = 10) {
	const file = path.join(getTaskDir(cwd, taskId), "log.txt");
	if (!fs.existsSync(file)) return [];
	const raw = await fs.promises.readFile(file, "utf-8");
	const all = raw.split("\n").filter((l) => l.length > 0);
	return all.slice(-lines);
}

/**
 * @param {string} cwd
 * @returns {Promise<TaskSummary[]>}
 */
export async function listTasks(cwd) {
	const root = getTasksRoot(cwd);
	if (!fs.existsSync(root)) return [];
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	/** @type {TaskSummary[]} */
	const summaries = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const status = await readStatus(cwd, entry.name);
		if (!status) continue;
		summaries.push({
			id: status.id,
			dir: path.join(root, entry.name),
			state: status.state,
			stage: status.stage,
			progress: status.progress,
			updatedAt: status.updatedAt,
			input: status.input,
		});
	}
	summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return summaries;
}
