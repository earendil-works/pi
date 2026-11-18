// The owner's machines at Radius (servers of kind `env`, each running `pi-env agent`): listing them, minting an
// enrollment code with the commands that install the agent, and installing it on an SSH environment with such a code.

import { type RemotePlatform, runDaemon, type SshConnectOptions } from "@earendil-works/pi-env";
import { arr, compile, obj, opt, str, union } from "@earendil-works/pi-schema";
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
const InstallAnswer = compile(obj({ server_id: str(), service: str() }, { open: true }));

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

/** A new enrollment code for a machine named `name` (a hint the agent may override), valid for an hour. */
export async function enrollMachine(access: () => Promise<OwnerRadius>, name?: string): Promise<Enrollment> {
	const answer = await radiusApi(access, "POST", "/v1/pi/servers/enrollments", name === undefined ? {} : { name });
	// Radius's answer is wire input.
	if (!EnrollmentAnswer.check(answer)) throw new Error("Radius answered the enrollment unexpectedly");
	return {
		code: answer.code,
		expiresAt: answer.expires_at,
		gateway: answer.gateway,
		install: { sh: answer.install.sh, ps1: answer.install.ps1 },
	};
}

/** How long `pi-env install` may take: it enrolls with Radius and starts the service. */
const INSTALL_TIMEOUT_MS = 180_000;

/**
 * Installs `pi-env agent` as a service on an SSH environment: the daemon deployed there (`file`) runs `install` with a
 * new enrollment code on its stdin (never on a command line, which other users of the machine can read), enrolling as
 * `name`. Returns the machine's Radius server ID and the service that runs it.
 */
export async function installAgent(
	access: () => Promise<OwnerRadius>,
	target: SshConnectOptions,
	remote: RemotePlatform,
	file: string,
	name: string,
): Promise<Installed> {
	const enrollment = await enrollMachine(access, name);
	const output = await runDaemon(
		target,
		remote,
		file,
		["install", "--gateway", enrollment.gateway, "--name", name, "--code-stdin"],
		{ stdin: `${enrollment.code}\n`, timeoutMs: INSTALL_TIMEOUT_MS },
	);
	const line = output.trim().split("\n").at(-1) ?? "";
	let answer: unknown;
	try {
		answer = JSON.parse(line);
	} catch {
		throw new Error(`Unexpected answer from pi-env install: ${line.slice(0, 200)}`);
	}
	// The machine's answer is wire input.
	if (!InstallAnswer.check(answer)) throw new Error(`Unexpected answer from pi-env install: ${line.slice(0, 200)}`);
	return { server: answer.server_id, service: answer.service };
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
