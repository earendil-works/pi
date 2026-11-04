// `/envs` in the TUI (p2-tui-port.md P11e, section 10.6): the one environment screen. This device and the owner's SSH
// environments, the viewed session's one marked; Enter moves the session to the selected one (the sessions plugin's
// place: the directory prompt there, then `Sessions.relocate`). Management stays on secondary keys, after the web's
// environments panel: Ctrl+T tests, Ctrl+K reviews a host key the test could not verify (accepted only after a
// confirmation that shows its fingerprints), Ctrl+F forgets a trusted one. Editing configurations stays on the web.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	follow,
	followRegistry,
	liveIn,
	statusOf,
	whenLive,
} from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	confirm,
	ListOverlay,
	type ListRow,
	lineText,
	type TuiCommand,
	TuiCommands,
	type TuiSessionPlace,
	TuiSessionPlaces,
} from "@p2/app/v1/tui";
import { type EnvSummary, Envs } from "./contract.ts";

function detail(env: EnvSummary): string {
	const test = env.test;
	if (!test) return "untested";
	if (test.ok) return `ok · ${test.platform} ${test.arch} · ${test.latencyMs} ms`;
	return test.hostKey ? `host key ${test.hostKey.state}` : "failed";
}

/** The row of this device (environment names never contain NUL). */
const LOCAL = "\0local";

function openEnvs(ctx: TuiContext): void {
	const ref = ctx.host.hold(Envs, {}, BACKGROUND_CONTEXT);
	let place: TuiSessionPlace | undefined;
	let envs: EnvSummary[] = [];
	let status = "";
	let failure: string | null = null;
	const stops = [
		// Moving needs the sessions plugin; without it the screen only manages environments.
		followRegistry(ctx.host, TuiSessionPlaces, (table) => {
			place = [...table.values()][0];
			ctx.requestRender();
		}),
		follow(ref.envs, (value) => {
			envs = value ?? [];
			ctx.requestRender();
		}),
		// The configuration file could not be read: the list is what was last loaded.
		follow(ref.failure, (value) => {
			failure = value ?? null;
			ctx.requestRender();
		}),
	];
	void whenLive(ref).then(
		// The environments' connections start now, as the web's picker does: moving or testing need not wait for ssh.
		() => {
			if (statusOf(ref) === "live" && ref.variant === "owner") void ref.warm(BACKGROUND_CONTEXT).catch(() => {});
		},
		(error: unknown) => {
			status = error instanceof Error ? error.message : String(error);
		},
	);
	const owner = () => liveIn(ref, "owner");
	const run = (label: string, action: () => Promise<unknown>) => {
		status = `${label}…`;
		ctx.requestRender();
		void action()
			.then(() => {
				status = `${label}: done`;
			})
			.catch((error: unknown) => {
				status = `${label}: ${error instanceof Error ? error.message : String(error)}`;
			})
			.finally(() => ctx.requestRender());
	};
	const byRow = (row: ListRow | undefined) => envs.find((env) => env.name === row?.key);
	const here = () => place?.where(ctx);
	const close = () => {
		for (const stop of stops) stop();
		ref.release();
		overlay.close();
	};
	const accept = async (env: EnvSummary) => {
		const service = owner();
		const key = env.test && !env.test.ok ? env.test.hostKey : undefined;
		if (!service || service.variant !== "owner" || !key) return;
		const yes = await confirm(ctx, [
			`Trust ${env.name}'s host key?`,
			`${lineText(env.config.user ? `${env.config.user}@` : "")}${lineText(env.config.host)}${env.config.port ? `:${env.config.port}` : ""} · ${key.state === "changed" ? "the key CHANGED since it was trusted" : "unknown key"}`,
			...key.fingerprints.map((fingerprint) => `  ${lineText(fingerprint)}`),
			"Compare the fingerprints with the server's own before you trust it.",
		]);
		if (yes)
			run(`Trusting ${env.name}`, () =>
				service.acceptHostKey({ name: env.name, lines: key.lines }, BACKGROUND_CONTEXT),
			);
	};
	const overlay = ctx.overlay(
		"envs",
		new ListOverlay(ctx, {
			title: () => `Environments (${envs.length})`,
			rows: () => {
				const current = here();
				const mark = (env: string | null) => (current && current.env === env ? "● " : "  ");
				return [
					{
						key: LOCAL,
						label: `${mark(null)}This device`,
						detail: current?.env === null ? "this session" : "",
						...(current?.env === null ? { color: "accent" as const } : {}),
					},
					...envs.map((env) => ({
						key: env.name,
						label: `${mark(env.name)}${env.name}  ${env.config.user ? `${env.config.user}@` : ""}${env.config.host}`,
						detail: `${current?.env === env.name ? "this session · " : ""}${detail(env)} · ${env.sessions} session${env.sessions === 1 ? "" : "s"}`,
						...(env.test && !env.test.ok
							? { description: env.test.error, color: "error" as const }
							: current?.env === env.name
								? { color: "accent" as const }
								: {}),
					})),
				];
			},
			// The session's environment first selected.
			selected: (() => {
				const env = place?.where(ctx)?.env;
				return env ? env : LOCAL;
			})(),
			onSelect: (row) => {
				if (!place?.where(ctx)) {
					ctx.notify("Open a session to move it", "warning");
					return;
				}
				const target = row.key === LOCAL ? null : row.key;
				const mover = place;
				close();
				void mover
					.moveTo(ctx, target)
					.catch((error: unknown) => ctx.notify(error instanceof Error ? error.message : String(error), "error"));
			},
			actions: [
				{
					key: "ctrl+k",
					label: "review host key",
					run: (row) => {
						const env = byRow(row);
						if (env?.test && !env.test.ok && env.test.hostKey) void accept(env);
						else if (env) ctx.notify(`${env.name} has no host key to review (Ctrl+T tests it)`);
					},
				},
				{
					key: "ctrl+t",
					label: "test",
					run: (row) => {
						const env = byRow(row);
						const service = owner();
						if (env && service?.variant === "owner")
							run(`Testing ${env.name}`, () => service.test({ name: env.name }, BACKGROUND_CONTEXT));
					},
				},
				{
					key: "ctrl+f",
					label: "forget host key",
					run: (row) => {
						const env = byRow(row);
						const service = owner();
						if (!env || service?.variant !== "owner") return;
						void confirm(ctx, [`Forget ${env.name}'s trusted host key?`, "The next connection asks again."]).then(
							(yes) =>
								yes &&
								run(`Forgetting ${env.name}'s key`, () =>
									service.forgetHostKey({ name: env.name }, BACKGROUND_CONTEXT),
								),
						);
					},
				},
			],
			footer: () => [
				...(failure ? [ctx.theme.current.fg("error", `  ${lineText(failure)}`)] : []),
				ctx.theme.current.fg(
					"dim",
					`  Enter moves this session there (● marks where it runs); Ctrl+K reviews an unverified host key`,
				),
				...(status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			],
			onClose: close,
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.envs": {
		title: "Environments",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "envs" },
		run: (ctx) => openEnvs(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-envs", (self) => {
		self.contribute(TuiCommands, COMMANDS);
	}),
);
