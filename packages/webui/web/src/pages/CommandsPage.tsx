import { useState, useCallback, useEffect } from "react";
import { Plus, Trash2, Check, X, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import type { QuickCommand } from "../lib/api";
import { validateQuickCommand } from "../lib/slash-commands";
import { useQuickCommands } from "../lib/useQuickCommands";

export default function CommandsPage() {
	const { commands, loading, error, save } = useQuickCommands();
	const [rows, setRows] = useState<QuickCommand[]>([]);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [addingNew, setAddingNew] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Sync local `rows` from hook whenever it loads / reloads — unless we
	// have unsaved changes, in which case we keep the user's edits.
	useEffect(() => {
		if (!dirty) setRows(commands);
	}, [commands, dirty]);

	const handleEdit = useCallback((idx: number, next: QuickCommand) => {
		setRows((prev) => {
			const copy = prev.slice();
			copy[idx] = next;
			return copy;
		});
		setDirty(true);
	}, []);

	const handleDelete = useCallback((idx: number) => {
		setRows((prev) => prev.filter((_, i) => i !== idx));
		setEditingIdx(null);
		setDirty(true);
	}, []);

	const handleAdd = useCallback((cmd: QuickCommand) => {
		setRows((prev) => [...prev, cmd]);
		setAddingNew(false);
		setDirty(true);
	}, []);

	const handleSaveAll = useCallback(async () => {
		setSaveError(null);
		try {
			await save(rows);
			setDirty(false);
		} catch (e) {
			setSaveError(e instanceof Error ? e.message : String(e));
		}
	}, [rows, save]);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full">
				<p className="text-stone-500">Loading...</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<header className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50">
				<div className="flex items-center gap-2">
					<Terminal size={18} className="text-stone-500" />
					<h1 className="text-lg font-semibold text-stone-800">Quick Commands</h1>
				</div>
				<div className="flex items-center gap-2">
					<Link to="/" className="text-sm text-stone-500 hover:text-blue-600 hover:underline">
						Back to chat
					</Link>
					<button
						type="button"
						onClick={() => setAddingNew(true)}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
					>
						<Plus size={14} />
						Add command
					</button>
					<button
						type="button"
						onClick={() => void handleSaveAll()}
						disabled={!dirty}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-stone-700 text-white hover:bg-stone-800 disabled:opacity-50"
					>
						<Check size={14} />
						Save changes
					</button>
				</div>
			</header>
			<div className="flex-1 overflow-y-auto p-6">
				{error && (
					<div className="mb-4 px-3 py-2 rounded border border-red-300 bg-red-50 text-sm text-red-700">
						{error.message}
					</div>
				)}
				{saveError && (
					<div className="mb-4 px-3 py-2 rounded border border-red-300 bg-red-50 text-sm text-red-700">
						Save failed: {saveError}
					</div>
				)}
				{dirty && (
					<div className="mb-4 px-3 py-2 rounded border border-amber-300 bg-amber-50 text-sm text-amber-800">
						You have unsaved changes.
					</div>
				)}
				{rows.length === 0 && !addingNew && (
					<div className="text-center py-12 text-stone-500">
						<p>No quick commands configured yet.</p>
						<p className="text-sm mt-1">Click "Add command" to create your first one.</p>
					</div>
				)}
				<div className="space-y-3 max-w-3xl">
					{rows.map((cmd, idx) =>
						editingIdx === idx ? (
							<CommandEditRow
								key={`${cmd.name}-${idx}`}
								initial={cmd}
								existing={rows}
								ignoreIndex={idx}
								onSave={(next) => handleEdit(idx, next)}
								onCancel={() => setEditingIdx(null)}
								onDelete={() => handleDelete(idx)}
							/>
						) : (
							<CommandDisplayRow
								key={`${cmd.name}-${idx}`}
								cmd={cmd}
								onEdit={() => setEditingIdx(idx)}
							/>
						),
					)}
					{addingNew && (
						<CommandEditRow
							initial={{ name: "", prompt: "" }}
							existing={rows}
							ignoreIndex={-1}
							onSave={handleAdd}
							onCancel={() => setAddingNew(false)}
							isNew
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function CommandDisplayRow({
	cmd,
	onEdit,
}: {
	cmd: QuickCommand;
	onEdit: () => void;
}) {
	return (
		<div className="flex items-start gap-3 p-3 rounded border border-stone-200 bg-white hover:border-stone-300">
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<code className="text-sm font-mono text-blue-700">/{cmd.name}</code>
					{cmd.description && (
						<span className="text-sm text-stone-600">{cmd.description}</span>
					)}
				</div>
				<pre className="mt-1 text-xs text-stone-500 whitespace-pre-wrap break-words">
					{cmd.prompt}
				</pre>
			</div>
			<button
				type="button"
				onClick={onEdit}
				className="text-xs text-blue-600 hover:underline"
			>
				Edit
			</button>
		</div>
	);
}

function CommandEditRow({
	initial,
	existing,
	ignoreIndex,
	onSave,
	onCancel,
	onDelete,
	isNew,
}: {
	initial: QuickCommand;
	existing: ReadonlyArray<QuickCommand>;
	ignoreIndex: number;
	onSave: (cmd: QuickCommand) => void;
	onCancel: () => void;
	onDelete?: () => void;
	isNew?: boolean;
}) {
	const [name, setName] = useState(initial.name);
	const [description, setDescription] = useState(initial.description ?? "");
	const [prompt, setPrompt] = useState(initial.prompt);
	const trimmedName = name.trim();
	const candidate: QuickCommand = {
		name: trimmedName,
		description: description.trim() || undefined,
		prompt,
	};
	const validation = validateQuickCommand(candidate, existing, ignoreIndex);

	return (
		<div className="flex flex-col gap-2 p-3 rounded border border-blue-300 bg-blue-50/30">
			<div className="flex flex-wrap gap-2">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="name (e.g. review)"
					className="px-2 py-1 text-sm rounded border border-stone-300 w-48 font-mono"
					aria-label="Command name"
					autoFocus={isNew}
				/>
				<input
					type="text"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="description (optional)"
					className="px-2 py-1 text-sm rounded border border-stone-300 flex-1 min-w-0"
					aria-label="Command description"
				/>
			</div>
			<textarea
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				placeholder="prompt (use $ARG for the user-supplied argument)"
				className="px-2 py-1 text-sm rounded border border-stone-300 w-full resize-y font-mono"
				rows={3}
				aria-label="Command prompt"
			/>
			{validation && <div className="text-xs text-amber-700">{validation}</div>}
			<div className="flex gap-2">
				<button
					type="button"
					onClick={() => onSave(candidate)}
					disabled={!!validation}
					className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
				>
					<Check size={12} />
					{isNew ? "Add" : "Save"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-stone-300 text-stone-600 hover:border-stone-400"
				>
					<X size={12} />
					Cancel
				</button>
				{onDelete && (
					<button
						type="button"
						onClick={onDelete}
						className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-red-300 text-red-700 hover:bg-red-50"
					>
						<Trash2 size={12} />
						Delete
					</button>
				)}
			</div>
		</div>
	);
}