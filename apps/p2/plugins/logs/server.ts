import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import { contribute, defineFacet, deriveTyped, forbidden, isOwner } from "@p2/app/v1";
import { captureProcessLogs, type LogSnapshot, processLogs } from "@p2/app/v1/node";
import { Server } from "@p2/app/v1/server";
import { LogLineSchema, LogNotices, Logs } from "./contract.ts";

const SnapshotSchema = obj({ source: str(), lines: arr(LogLineSchema, { maxItems: 1000 }) }, { open: true });
const isSnapshot = compile(SnapshotSchema).check;

export default defineFacet((host) => {
	contribute(host, "p2.log-host", (self) => {
		const server = self.get(Server, {});
		self.open(
			async () => {
				const directory = server.info.value.dataDir;
				processLogs.redactor.addDirectory(directory);
				const stop = captureProcessLogs("server");
				processLogs.append("server", "event", "Server logs connected");
				// Detached processes publish private, bounded, redacted snapshots, not raw append-only files.
				const fingerprints = new Map<string, string>();
				const seen = new Map<string, Set<string>>();
				let active: Promise<void> | undefined;
				const collect = (): void => {
					if (active) return;
					active = (async () => {
						for (const source of ["terminals", "dev"]) {
							const path = join(directory, `${source}.logs.json`);
							try {
								const info = await stat(path, { bigint: true });
								if (info.size > 2 * 1024 * 1024) continue;
								const fingerprint = `${info.ino}:${info.mtimeNs}:${info.size}`;
								if (fingerprints.get(source) === fingerprint) continue;
								const snapshot: unknown = JSON.parse(await readFile(path, "utf8"));
								if (!isSnapshot(snapshot) || snapshot.source !== source) continue;
								const incoming = snapshot as LogSnapshot;
								const prior = seen.get(source);
								const next = new Set<string>();
								for (const line of incoming.lines) {
									const key = `${line.id}:${line.time}`;
									next.add(key);
									if (!prior?.has(key)) {
										processLogs.append(source, line.level, line.text, line.time);
										if (line.level === "error" && /^(?:\w*Error):/.test(line.text))
											processLogs.notice(source, line.text);
									}
								}
								seen.set(source, next);
								fingerprints.set(source, fingerprint);
							} catch {
								/* Not running, or an incomplete/corrupt publication. */
							}
						}
					})().finally(() => {
						active = undefined;
					});
				};
				collect();
				const timer = setInterval(collect, 300);
				timer.unref();
				return { stop, timer, done: () => active };
			},
			async ({ stop, timer, done }) => {
				clearInterval(timer);
				stop();
				await done();
			},
		);
	});

	host.serve(LogNotices, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Notices are only available to owners");
		const notices = self.writable(processLogs.notices());
		self.open(
			async () => processLogs.events.subscribe(() => notices.set(processLogs.notices())),
			(stop) => stop(),
		);
		return {
			variant: "owner",
			members: {
				notices: deriveTyped(self, [notices], ([value]) => value),
				dismiss: async ({ id }) => {
					processLogs.dismissNotice(id);
					return null;
				},
			},
		};
	});

	host.serve(Logs, ({ source }, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Logs are only available to owners");
		const sources = self.writable(processLogs.sources());
		const lines = self.writable(processLogs.lines(source));
		self.open(
			async () =>
				processLogs.events.subscribe((changed) => {
					sources.set(processLogs.sources());
					if (changed === source || !processLogs.sources().some((entry) => entry.id === source))
						lines.set(processLogs.lines(source));
				}),
			(stop) => stop(),
		);
		return {
			variant: "owner",
			members: {
				sources: deriveTyped(self, [sources], ([value]) => value),
				lines: deriveTyped(self, [lines], ([value]) => value),
			},
		};
	});
});
