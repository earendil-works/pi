// Private on-disk job metadata and validated worker/control state.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const JobNamingSchema = Type.Union([
	Type.Object({ status: Type.Literal("explicit") }),
	Type.Object({ status: Type.Literal("pending") }),
	Type.Object({ status: Type.Literal("running") }),
	Type.Object({ status: Type.Literal("generated") }),
	Type.Object({ status: Type.Literal("failed"), error: Type.String() }),
]);

export const JobSpecSchema = Type.Object({
	id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	name: Type.String(),
	naming: Type.Optional(JobNamingSchema),
	command: Type.String(),
	cwd: Type.String(),
	createdAt: Type.Number(),
	sessionId: Type.Optional(Type.String()),
	token: Type.String({ minLength: 64, maxLength: 64 }),
	shell: Type.Object({
		shell: Type.String(),
		args: Type.Array(Type.String()),
		commandTransport: Type.Optional(Type.Union([Type.Literal("argv"), Type.Literal("stdin")])),
	}),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483.647 })),
});
export type JobSpec = Static<typeof JobSpecSchema>;

export const JobRuntimeSchema = Type.Union([
	Type.Object({ state: Type.Literal("starting"), startedAt: Type.Number() }),
	Type.Object({
		state: Type.Literal("running"),
		startedAt: Type.Number(),
		workerPid: Type.Integer({ minimum: 1 }),
		processPid: Type.Integer({ minimum: 1 }),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
	}),
	Type.Object({
		state: Type.Union([
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("stopped"),
			Type.Literal("timed_out"),
		]),
		startedAt: Type.Number(),
		endedAt: Type.Number(),
		exitCode: Type.Union([Type.Number(), Type.Null()]),
		error: Type.Optional(Type.String()),
	}),
]);
export type JobRuntime = Static<typeof JobRuntimeSchema>;

export const JobProgressSchema = Type.Object({
	percent: Type.Number({ minimum: 0, maximum: 100 }),
	message: Type.Optional(Type.String({ maxLength: 1024 })),
});
export type JobProgress = Static<typeof JobProgressSchema>;

export const JobRequestSchema = Type.Object({
	proof: Type.String(),
	action: Type.Union([Type.Literal("status"), Type.Literal("stop")]),
});
export const JobReplySchema = Type.Object({ proof: Type.String(), runtime: JobRuntimeSchema });

export const JobInfoSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	naming: Type.Optional(JobNamingSchema),
	command: Type.String(),
	cwd: Type.String(),
	createdAt: Type.Number(),
	sessionId: Type.Optional(Type.String()),
	runtime: Type.Union([
		JobRuntimeSchema,
		Type.Object({
			state: Type.Union([Type.Literal("lost"), Type.Literal("unreachable")]),
			startedAt: Type.Number(),
			error: Type.String(),
		}),
	]),
	progress: Type.Optional(JobProgressSchema),
	progressError: Type.Optional(Type.String()),
	logPath: Type.String(),
	workerLogPath: Type.String(),
});
export type JobInfo = Static<typeof JobInfoSchema>;

const specValidator = Compile(JobSpecSchema);
const runtimeValidator = Compile(JobRuntimeSchema);
const progressValidator = Compile(JobProgressSchema);
const recordLimits = { "spec.json": 1024 * 1024, "runtime.json": 64 * 1024, "progress.json": 16 * 1024 };
type RecordName = keyof typeof recordLimits;

/** Read a job specification at the private on-disk metadata boundary. */
export function readJobSpec(directory: string): JobSpec {
	const value = readRecord(directory, "spec.json");
	if (!specValidator.Check(value)) throw new Error(`Invalid job metadata: ${directory}`);
	return value;
}

/** Read the worker-owned status at the on-disk metadata boundary. */
export function readJobRuntime(directory: string): JobRuntime {
	const value = readRecord(directory, "runtime.json");
	if (!runtimeValidator.Check(value)) throw new Error(`Invalid job status: ${directory}`);
	return value;
}

/** Read explicit job progress; malformed reports stay visible as errors, not guessed percentages. */
export function readJobProgress(directory: string): { progress?: JobProgress; progressError?: string } {
	try {
		const value = readRecord(directory, "progress.json");
		if (!progressValidator.Check(value))
			return { progressError: "Invalid progress report; expected percent 0–100 and optional message" };
		return { progress: value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { progressError: error instanceof Error ? error.message : String(error) };
	}
}

/** Publish one complete private JSON record without exposing partially written state to readers. */
export function writeJobRecord(directory: string, name: RecordName, value: unknown): void {
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > recordLimits[name])
		throw new Error(`Job record ${name} exceeds ${recordLimits[name]} bytes`);
	const temporary = join(directory, `.${name}-${randomUUID()}`);
	try {
		writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
		renameSync(temporary, join(directory, name));
	} finally {
		rmSync(temporary, { force: true });
	}
}

function readRecord(directory: string, name: RecordName): unknown {
	const path = join(directory, name);
	// Files are job-controlled; refuse devices/FIFOs and bound both reads and allocation.
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`Job record is not a regular file: ${path}`);
		const limit = recordLimits[name];
		if (stat.size > limit) throw new Error(`Job record ${name} exceeds ${limit} bytes`);
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > stat.size) throw new Error(`Job record changed while reading: ${path}; publish progress atomically`);
		try {
			return JSON.parse(buffer.toString("utf8", 0, length));
		} catch {
			throw new Error(`Invalid JSON in job record: ${path}`);
		}
	} finally {
		closeSync(fd);
	}
}
