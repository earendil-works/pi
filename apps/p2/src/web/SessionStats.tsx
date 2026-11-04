import type { Usage } from "@earendil-works/pi-ai";
import type { ReactNode } from "react";
import { ContextUsage } from "./Chat.tsx";
import { UsersIcon } from "./icons.tsx";
import { cacheHitRate } from "./transcript.ts";
export function cost(value: number): string {
	return value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`;
}

/** Cache hit share of the latest assistant response, independent of session-wide spend. */
export function UsageLine({ usage }: { usage?: Usage }) {
	const hit = usage ? cacheHitRate(usage) : undefined;
	return (
		<span
			className="usage"
			role="img"
			aria-label={`Cache hit rate: ${hit === undefined ? "unavailable" : `${Math.round(hit * 100)} percent`}`}
			title={
				usage
					? `Cache hit rate of latest assistant response: input ${usage.input} · cache read ${usage.cacheRead} · cache write ${usage.cacheWrite}`
					: "No assistant response in this conversation yet"
			}
		>
			chr {hit === undefined ? "—" : `${Math.round(hit * 100)}%`}
		</span>
	);
}

export function SessionStats({
	usage,
	cacheUsage,
	clients,
	context,
	onCost,
	onClients,
	controls,
}: {
	usage?: Usage;
	cacheUsage?: Usage;
	clients: number;
	/** The context bar's numbers; "pending" while they load (the bar's space stays), undefined for none. */
	context?: { used: number; limit: number } | "pending";
	onCost?: () => void;
	/** Owner only: open the share sheet from the viewer count. */
	onClients?: () => void;
	controls?: ReactNode;
}) {
	return (
		<div className="session-usage">
			{controls && <div className="session-controls">{controls}</div>}
			<div className="session-stats">
				{onClients ? (
					<button
						type="button"
						className="usage footer-action client-count"
						aria-label={`${clients} ${clients === 1 ? "browser" : "browsers"} viewing this session; share`}
						title="Browsers viewing this session, including subagent views. Open sharing."
						onClick={onClients}
					>
						<UsersIcon />
						{clients}
					</button>
				) : (
					<span
						className="usage client-count"
						role="img"
						aria-label={`${clients} ${clients === 1 ? "browser" : "browsers"} viewing this session`}
						title="Browsers viewing this session, including subagent views"
					>
						<UsersIcon />
						{clients}
					</span>
				)}
				<span className="usage"> · </span>
				<UsageLine usage={cacheUsage} />
				{usage && (
					<>
						<span className="usage"> · </span>
						{onCost ? (
							<button
								type="button"
								className="usage footer-action cost-link"
								title="Open response cost details; session total includes subagents and tools"
								onClick={onCost}
							>
								{cost(usage.cost.total)}
							</button>
						) : (
							<span className="usage" title="Session total cost: all conversations, subagents and tools">
								{cost(usage.cost.total)}
							</span>
						)}
					</>
				)}
			</div>
			{context === "pending" ? (
				<ContextUsage />
			) : (
				context && <ContextUsage used={context.used} limit={context.limit} />
			)}
		</div>
	);
}
