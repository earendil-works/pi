import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { QuickCommand } from "./api";

export interface UseQuickCommandsResult {
	commands: QuickCommand[];
	loading: boolean;
	error: Error | null;
	reload: () => Promise<void>;
	save: (commands: QuickCommand[]) => Promise<void>;
}

/**
 * Shared hook for the QuickCommandsBar (chat page) and CommandsPage
 * (sidebar route). Owns the read / write to `settings.webui.quickCommands`.
 *
 * The hook holds a local `commands` array so consumers can mutate UI state
 * (add row, edit prompt) without round-tripping through the server on each
 * keystroke. `save(commands)` flushes to disk; failures surface as `error`.
 */
export function useQuickCommands(): UseQuickCommandsResult {
	const [commands, setCommands] = useState<QuickCommand[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const reload = useCallback(async () => {
		try {
			const list = await api.getQuickCommands();
			if (!mountedRef.current) return;
			setCommands(list);
			setError(null);
		} catch (e) {
			if (!mountedRef.current) return;
			setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			if (mountedRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const save = useCallback(async (next: QuickCommand[]) => {
		setCommands(next);
		try {
			await api.setQuickCommands(next);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e : new Error(String(e)));
			throw e;
		}
	}, []);

	return { commands, loading, error, reload, save };
}