// The owner's machines at Radius (servers of kind `env`, each running `pi-env agent`): listing them, minting an
// enrollment code with the commands that install the agent, and installing it on an SSH environment with such a code.

import { arr, bool, compile, nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "@p2/app/v1";
import type { OwnerRadius } from "@p2/app/v1/node";
import type { Enrollment, Installed, RadiusMachine } from "./contract.ts";

const ListSchema = compile(
	obj(
		{
			servers: arr(
				obj(
					{
						serverId: str(),
						kind: str(),
						name: opt(str()),
						status: union([literal("online"), literal("offline"), literal("unknown")]),
						lastSeenAt: str(),
					},
					{ open: true },
				),
			),
		},
		{ open: true },
	),
);

const EnrollmentAnswer = compile(
	obj(
		{ code: str(), expires_at: str(), gateway: str(), install: obj({ sh: str(), ps1: str() }, { open: true }) },
		{ open: true },
	),
);

/** `pi-env install`'s last line of output. */
const InstallAnswer = compile(
	obj(
		{
			server_id: str(),
			service: str(),
			linger: opt(union([bool(), nul()])),
			notes: opt(arr(str())),
		},
		{ open: true },
	),
);

/** The owner's machines (`GET /v1/pi/servers?kind=env`), as Radius lists them. */
export async function listMachines(access: () => Promise<OwnerRadius>): Promise<RadiusMachine[]> {
	const answer = await radiusApi(access, "GET", "/v1/pi/servers?kind=env");
	// Radius's answer is wire input.
	if (!ListSchema.check(answer)) throw new Error("Radius listed the machines unexpectedly");
	return answer.servers
		.filter((server) => server.kind === "env")
		.map((server) => ({
			server: server.serverId,
			...(server.name === undefined ? {} : { name: server.name }),
			status: server.status,
			lastSeenAt: server.lastSeenAt,
		}));
}

/**
 * A new enrollment code for a machine named `name` (a hint the agent may override), valid for an hour. With `server`, a
 * re-enroll code bound to that machine of the owner: the agent enrolls again under its ID (and Radius revokes its
 * earlier grants) instead of becoming a new machine.
 */
export async function enrollMachine(
	access: () => Promise<OwnerRadius>,
	name?: string,
	server?: string,
): Promise<Enrollment> {
	const answer = await radiusApi(access, "POST", "/v1/pi/servers/enrollments", {
		...(name === undefined ? {} : { name }),
		...(server === undefined ? {} : { server_id: server }),
	});
	// Radius's answer is wire input.
	if (!EnrollmentAnswer.check(answer)) throw new Error("Radius answered the enrollment unexpectedly");
	return {
		code: answer.code,
		expiresAt: answer.expires_at,
		gateway: answer.gateway,
		install: { sh: answer.install.sh, ps1: answer.install.ps1 },
	};
}

/** Runs the daemon deployed on a machine once with `args` (`stdin` on its standard input); resolves with its stdout. */
export type RunDaemon = (args: readonly string[], stdin?: string) => Promise<string>;

/** How long `pi-env install` may take: it enrolls with Radius and starts the service. */
export const INSTALL_TIMEOUT_MS = 180_000;

/**
 * Installs `pi-env agent` as a service on a machine with its daemon (`run`): `install` with an enrollment code on its
 * stdin (never on a command line, which other users of the machine can read), enrolling as `name`. A machine whose
 * agent already enrolled with this Radius as one of the owner's machines (an earlier install) gets a re-enroll code for
 * that machine and keeps its ID: installing twice never leaves a second machine behind.
 */
export async function installAgent(
	access: () => Promise<OwnerRadius>,
	run: RunDaemon,
	name: string,
): Promise<Installed> {
	const enrolled = await enrolledServer(access, run);
	const enrollment = await enrollMachine(access, name, enrolled);
	const answer = lastJson(
		await run(["install", "--gateway", enrollment.gateway, "--name", name, "--code-stdin"], `${enrollment.code}\n`),
		InstallAnswer,
		"pi-env install",
	);
	return {
		server: answer.server_id,
		service: answer.service,
		linger: answer.linger ?? null,
		notes: answer.notes ?? [],
	};
}

/** `pi-env status`'s answer (the fields read here). */
const StatusAnswer = compile(
	obj({ enrolled: bool(), gateway: union([str(), nul()]), serverId: union([str(), nul()]) }, { open: true }),
);

/**
 * The server ID the machine's agent enrolled with, when that is one of the owner's machines at this Radius; undefined
 * for a machine without an agent, or a daemon too old to have `status`.
 */
async function enrolledServer(access: () => Promise<OwnerRadius>, run: RunDaemon): Promise<string | undefined> {
	let status: { enrolled: boolean; gateway: string | null; serverId: string | null };
	try {
		status = lastJson(await run(["status"]), StatusAnswer, "pi-env status");
	} catch {
		return undefined;
	}
	const { gateway } = await access();
	if (!status.enrolled || status.serverId === null || status.gateway === null) return undefined;
	if (new URL(status.gateway).origin !== new URL(gateway).origin) return undefined;
	const server = status.serverId;
	return (await listMachines(access)).some((machine) => machine.server === server) ? server : undefined;
}

/** The JSON of `output`'s last line, checked with `schema` (the machine's answer is wire input). */
function lastJson<T>(output: string, schema: { check(value: unknown): value is T }, what: string): T {
	const line = output.trim().split("\n").at(-1) ?? "";
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error(`Unexpected answer from ${what}: ${line.slice(0, 200)}`);
	}
	if (!schema.check(value)) throw new Error(`Unexpected answer from ${what}: ${line.slice(0, 200)}`);
	return value;
}

/** One request to Radius's API as the owner; a refusal rejects with Radius's status and message. */
async function radiusApi(
	access: () => Promise<OwnerRadius>,
	method: "GET" | "POST",
	path: string,
	body?: object,
): Promise<unknown> {
	const { gateway, token } = await access();
	const response = await fetch(new URL(path, gateway), {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Radius refused (${response.status}: ${(await response.text()).slice(0, 200)})`);
	return response.json();
}
