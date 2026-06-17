import { useCallback, useEffect, useRef, useState } from "react";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutoSaveOptions<T> {
	/** Debounce delay in ms before calling onSave after the last change. Default 3000. */
	delay?: number;
	/** Flush deadline in ms when the caller needs to wait synchronously (e.g. route change). Default 200. */
	flushDeadline?: number;
	/** Called when the value changes and debounce elapses. Returns a promise that resolves on success. */
	onSave: (value: T) => Promise<void>;
}

export interface UseAutoSaveResult<T> {
	/** Latest saved value (or last attempted). */
	savedValue: T;
	/** Current status. */
	status: AutoSaveStatus;
	/** Error from the last save attempt, if any. */
	error: Error | null;
	/** Manually trigger a save (bypasses debounce). Returns a promise that resolves when save completes. */
	flush: () => Promise<void>;
}

/**
 * Auto-save hook with debounce + unmount flush.
 *
 * Behavior:
 * - `value` changes → start a `delay` ms timer; when it fires, call `onSave(value)`.
 * - If `value` changes again before timer fires, reset the timer.
 * - On unmount (cleanup), if a save is pending, fire `flush()` and wait up to `flushDeadline` ms.
 *   If the save doesn't complete in time, log a warning (don't block unmount).
 * - Status transitions: idle → saving → saved | error.
 *
 * @param value The value to auto-save.
 * @param opts Hook options.
 */
export function useAutoSave<T>(value: T, opts: UseAutoSaveOptions<T>): UseAutoSaveResult<T> {
	const { delay = 3000, flushDeadline = 200, onSave } = opts;
	const [status, setStatus] = useState<AutoSaveStatus>("idle");
	const [error, setError] = useState<Error | null>(null);
	const [savedValue, setSavedValue] = useState<T>(value);

	// Refs for the debounce timer and the in-flight flush promise
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestValueRef = useRef<T>(value);
	const onSaveRef = useRef(onSave);

	// Keep onSave ref current (avoid stale closure)
	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	const performSave = useCallback(async (val: T): Promise<void> => {
		setStatus("saving");
		setError(null);
		try {
			await onSaveRef.current(val);
			setSavedValue(val);
			setStatus("saved");
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
			setStatus("error");
			// Don't throw — caller wants to retry next change, not crash
		}
	}, []);

	// When value changes, (re)start the debounce timer
	useEffect(() => {
		latestValueRef.current = value;
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
		}
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			void performSave(value);
		}, delay);
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [value, delay, performSave]);

	// Flush on unmount: if there's a pending save, run it; wait up to flushDeadline
	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
				// Run save synchronously (fire-and-forget) but cap wait
				const val = latestValueRef.current;
				const savePromise = performSave(val);
				// Best-effort wait: use Promise.race with a timeout
				Promise.race([
					savePromise,
					new Promise<void>((resolve) => setTimeout(resolve, flushDeadline)),
				]).catch(() => {});
			}
		};
		// We intentionally only run this on unmount, not when value changes
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const flush = useCallback(async (): Promise<void> => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		await performSave(latestValueRef.current);
	}, [performSave]);

	return { savedValue, status, error, flush };
}
