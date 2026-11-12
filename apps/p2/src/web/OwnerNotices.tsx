// One owner-only notice lane, in normal layout below the top bar. Never an overlay on the composer.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDevNotices } from "../hosts/web/DevNotice.tsx";
import { LogNotices } from "../runtime/notices.ts";
import {
	closeLayers,
	openLayer,
	Sheet,
	useConnected,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "../runtime/web.tsx";
import {
	DISMISSED_NOTICE_PREFIX,
	isSuccessResult,
	noticeWasDismissed,
	rememberDismissedNotice,
} from "./notice-state.ts";
import "./owner-notices.css";

export type OwnerNotice = {
	id: string;
	tone: "pending" | "success" | "error" | "info";
	message: string;
	details?: string;
	actions?: readonly { label: string; disabled?: boolean; run: () => void }[];
	onDismiss?: () => void;
	/** Equivalent native/dev event identities: dismissing a merged card records every identity. */
	dismissIds?: readonly string[];
};

function NoticeCard({
	notice,
	dismiss,
	showDetails,
}: {
	notice: OwnerNotice;
	dismiss: (notice: OwnerNotice) => void;
	showDetails: (notice: OwnerNotice) => void;
}) {
	// A poll/new array is not a new success: only a new notice identity starts this timer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: dismiss uses the current notice; identity/tone own its lifetime.
	useEffect(() => {
		if (notice.tone !== "success") return;
		const timer = setTimeout(() => dismiss(notice), 5000);
		return () => clearTimeout(timer);
	}, [notice.id, notice.tone, dismiss]);
	const label = notice.details ? (
		<button
			type="button"
			className="owner-notice-summary"
			onClick={() => showDetails(notice)}
			aria-label={`${notice.message} · Details`}
		>
			{notice.message}
		</button>
	) : (
		<span className="owner-notice-summary">{notice.message}</span>
	);
	return (
		<section
			className={`owner-notice ${notice.tone}`}
			aria-label={notice.tone === "pending" ? "Pending development change" : "Owner notification"}
		>
			{notice.tone === "error" ? (
				<div className="owner-notice-message" role="alert">
					{label}
				</div>
			) : (
				<output className="owner-notice-message">{label}</output>
			)}
			<div className="owner-notice-actions">
				{notice.tone === "pending" && (
					<span className="owner-notice-dot" aria-hidden="true">
						·
					</span>
				)}
				{notice.actions?.map((action) => (
					<button
						key={action.label}
						type="button"
						className="button"
						disabled={action.disabled}
						onClick={action.run}
					>
						{action.label}
					</button>
				))}
				{notice.tone !== "pending" && (
					<button
						type="button"
						className="button"
						aria-label="Dismiss owner notice"
						onClick={() => dismiss(notice)}
					>
						Dismiss
					</button>
				)}
			</div>
		</section>
	);
}

export function OwnerNotices() {
	const owner = useOwner();
	const dev = useDevNotices(owner, useConnected());
	const service = useObject(LogNotices, owner ? {} : undefined);
	const snapshot = useReadable(service?.notices);
	const logs = snapshot ?? [];
	const initialLogs = useRef<ReadonlySet<string> | undefined>(undefined);
	if (snapshot !== undefined) initialLogs.current ??= new Set(snapshot.map((log) => `log:${log.id}:${log.time}`));
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		const stored = (event: StorageEvent) => {
			if (event.key?.startsWith(DISMISSED_NOTICE_PREFIX) && event.newValue === "1")
				setDismissed((current) => new Set([...current, event.key!.slice(DISMISSED_NOTICE_PREFIX.length)]));
		};
		window.addEventListener("storage", stored);
		return () => window.removeEventListener("storage", stored);
	}, []);
	// Snapshot only the detail content: a POST acknowledgement can be replaced by the next status poll.
	// The route, not this cache, owns whether the sheet is open.
	const [selected, setSelected] = useState<Pick<OwnerNotice, "id" | "tone" | "message" | "details">>();
	const showDetails = (notice: OwnerNotice) => {
		setSelected({ id: notice.id, tone: notice.tone, message: notice.message, details: notice.details });
		openLayer({ kind: "sheet", name: "owner-notice", locator: notice.id });
	};
	const dismiss = useCallback((notice: OwnerNotice) => {
		const ids = [notice.id, ...(notice.dismissIds ?? [])];
		setDismissed((current) => new Set([...current, ...ids]));
		if (notice.tone === "error") for (const id of ids) rememberDismissedNotice(id);
		notice.onDismiss?.();
	}, []);
	const notices: OwnerNotice[] = [
		...dev,
		...logs
			.filter(
				(log) =>
					(!isSuccessResult(log.message) || !initialLogs.current?.has(`log:${log.id}:${log.time}`)) &&
					!dev.some((notice) => (notice.details ?? notice.message) === log.message),
			)
			.map((log) => ({
				id: `log:${log.id}:${log.time}`,
				tone: isSuccessResult(log.message) ? ("success" as const) : ("error" as const),
				message: `${log.source.startsWith("session:") ? "Worker" : log.source === "dev" ? "Dev supervisor" : log.source === "terminals" ? "Terminal host" : "Server"}: ${log.message}`,
				details: log.message,
				actions: [
					{ label: "Show logs", run: () => openLayer({ kind: "sheet", name: "logs", locator: log.source }) },
				],
				onDismiss: () => {
					void service?.dismiss({ id: log.id }, BACKGROUND_CONTEXT).catch(() => {});
				},
			})),
	].map((notice) => {
		// A dev refusal can also be in the native error feed. One card dismisses both, not a second overlay.
		const duplicates = logs.filter((log) => (notice.details ?? notice.message) === log.message);
		return duplicates.length && notice.id.startsWith("dev:")
			? {
					...notice,
					dismissIds: duplicates.map((log) => `log:${log.id}:${log.time}`),
					onDismiss: () => {
						notice.onDismiss?.();
						for (const log of duplicates)
							void service?.dismiss({ id: log.id }, BACKGROUND_CONTEXT).catch(() => {});
					},
				}
			: notice;
	});
	const route = useRoute();
	const sheet = useSheet("owner-notice");
	const detail = sheet
		? selected?.id === sheet.locator
			? selected
			: notices.find((notice) => notice.id === sheet.locator)
		: undefined;
	const visible = notices.filter((notice) => !dismissed.has(notice.id) && !noticeWasDismissed(notice.id));
	if (!owner) return null;
	return (
		<>
			{!route.layers.length && visible.length > 0 && (
				<aside className="owner-notices" aria-label="Owner notices">
					<div className="owner-pending">
						{visible
							.filter((notice) => notice.tone === "pending")
							.map((notice) => (
								<NoticeCard key={notice.id} notice={notice} dismiss={dismiss} showDetails={showDetails} />
							))}
					</div>
					{visible
						.filter((notice) => notice.tone !== "pending")
						.map((notice) => (
							<NoticeCard key={notice.id} notice={notice} dismiss={dismiss} showDetails={showDetails} />
						))}
				</aside>
			)}
			{detail && (
				<Sheet title={detail.tone === "error" ? "Notice details" : detail.message} onClose={closeLayers}>
					<p className="notice owner-notice-details">{detail.details}</p>
				</Sheet>
			)}
		</>
	);
}
