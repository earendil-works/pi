// Development notices contribute to the shared owner lane; polling never reopens a dismissed notice.
import { useEffect, useRef, useState } from "react";
import type { DevCommand, DevStatus } from "../../runtime/dev-protocol.ts";
import { openLayer } from "../../runtime/web.tsx";
import { isSuccessResult } from "../../web/notice-state.ts";
import type { OwnerNotice } from "../../web/OwnerNotices.tsx";

export function useDevNotices(owner: boolean, connected: boolean): OwnerNotice[] {
	const [status, setStatus] = useState<DevStatus>();
	// Survives upstream reconnects but not a page load. Existing results are state, not new events.
	const initial = useRef<{ id?: string; time: number } | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [local, setLocal] = useState<{
		id: string;
		message: string;
		ok: boolean;
		previousNoticeId?: string;
		plugins?: readonly string[];
	}>();
	useEffect(() => {
		if (!owner) return;
		let closed = false;
		let timer: ReturnType<typeof setTimeout>;
		const read = async (): Promise<void> => {
			try {
				const response = await fetch("/__p2_dev");
				const value: unknown = response.ok ? await response.json() : null;
				if (!closed && value && typeof value === "object" && "phase" in value) {
					const next = value as DevStatus;
					initial.current ??= { id: next.noticeId, time: next.noticeTime ?? 0 };
					setStatus(next);
					// An unchanged poll cannot erase a POST/network failure; only a newer server notice replaces it.
					setLocal((current) =>
						next.message && next.noticeId !== current?.previousNoticeId ? undefined : current,
					);
				}
				if (value === null) return;
			} catch {
				/* An explicit backend restart reconnects; keep the captured notice until then. */
			}
			if (!closed) timer = setTimeout(() => void read(), 500);
		};
		void read();
		return () => {
			closed = true;
			clearTimeout(timer);
		};
	}, [owner]);
	const apply = async (command: DevCommand): Promise<void> => {
		setBusy(true);
		try {
			const response = await fetch("/__p2_dev", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(command),
			});
			const result: unknown = await response.json();
			if (result && typeof result === "object" && "message" in result && typeof result.message === "string")
				setLocal({
					id: crypto.randomUUID(),
					message: result.message,
					ok: response.ok && "ok" in result && result.ok === true,
					previousNoticeId: status?.noticeId,
					plugins:
						"plugins" in result &&
						Array.isArray(result.plugins) &&
						result.plugins.every((plugin) => typeof plugin === "string")
							? result.plugins
							: undefined,
				});
		} catch {
			setLocal({
				id: crypto.randomUUID(),
				message:
					command.action === "restart"
						? "Restart requested; reconnecting…"
						: "Reload request disconnected; check the server notice and logs",
				ok: command.action === "restart",
				previousNoticeId: status?.noticeId,
			});
		} finally {
			setBusy(false);
		}
	};
	if (!owner) return [];
	const notices: OwnerNotice[] = [];
	const dirty = status?.dirty ?? [];
	if (dirty.length)
		notices.push({
			id: "dev:dirty",
			tone: "pending",
			message: `${dirty.length} plugin${dirty.length === 1 ? "" : "s"} changed`,
			actions: [
				{
					label: "Reload",
					disabled: busy || !connected || status?.phase === "reloading",
					run: () => void apply({ action: "reload" }),
				},
			],
		});
	if (status?.restartNeeded)
		notices.push({
			id: "dev:runtime",
			tone: "pending",
			message: "Server code changed",
			details: status.restartFiles?.join("\n"),
			actions: [{ label: "Restart", disabled: busy || !connected, run: () => void apply({ action: "restart" }) }],
		});
	const message = local?.message ?? status?.message;
	if (message) {
		const reloaded = message.startsWith("Reloaded");
		const plugins = reloaded
			? local?.plugins?.length
				? local.plugins
				: status?.plugins.length
					? status.plugins
					: message.slice("Reloaded".length).trim().split(/,\s*/).filter(Boolean)
			: [];
		const success = local?.ok ?? (status?.phase === "ready" || isSuccessResult(message));
		// A fresh tab ignores the result current at its first successful connection. Local acknowledgements
		// still belong to the initiating tab; a reconnect in an existing tab retains the original baseline.
		const newEvent =
			status?.noticeId !== initial.current?.id && (status?.noticeTime ?? 0) >= (initial.current?.time ?? 0);
		if (success && !local && !newEvent) return notices;
		notices.push({
			id: `dev:${local?.id ?? status?.noticeId ?? message}`,
			tone: success ? "success" : status?.phase === "reloading" ? "info" : "error",
			message:
				reloaded && plugins.length
					? `Reloaded ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`
					: message,
			details: reloaded && plugins.length ? plugins.join("\n") : success ? undefined : message,
			actions: status?.hasLogs
				? [
						{
							label: "Show logs",
							run: () =>
								openLayer({
									kind: "sheet",
									name: "logs",
									locator: message.startsWith("Restart") ? "dev" : "server",
								}),
						},
					]
				: undefined,
		});
	}
	return notices;
}
