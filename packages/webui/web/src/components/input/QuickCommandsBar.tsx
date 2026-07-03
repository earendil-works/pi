import { useState, useCallback } from "react";
import { Plus, X, Check } from "lucide-react";
import type { QuickCommand } from "../../lib/api";
import { validateQuickCommand } from "../../lib/slash-commands";

interface QuickCommandsBarProps {
	commands: QuickCommand[];
	onInsert: (name: string) => void;
	onSave: (next: QuickCommand[]) => Promise<void>;
	onOpenManager: () => void;
}

/**
 * Docked bar above the chat input. Shows one chip per quick command.
 * Clicking a chip inserts `/<name> ` into the input. The `+` button opens
 * an inline add-row (name / prompt + Save / Cancel). Saving appends to the
 * persisted list and selects the new command for immediate use.
 */
export function QuickCommandsBar({
	commands,
	onInsert,
	onSave,
	onOpenManager,
}: QuickCommandsBarProps) {
	const [adding, setAdding] = useState(false);

	const handleAddClick = useCallback(() => {
		setAdding(true);
	}, []);

	const handleAddSave = useCallback(
		async (next: QuickCommand[]) => {
			await onSave(next);
			setAdding(false);
		},
		[onSave],
	);

	const handleAddCancel = useCallback(() => {
		setAdding(false);
	}, []);

	const handleDelete = useCallback(
		async (name: string) => {
			const next = commands.filter((c) => c.name !== name);
			await onSave(next);
		},
		[commands, onSave],
	);

	return (
		<div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-stone-200 bg-stone-50/80">
			{commands.length === 0 && !adding && (
				<span className="text-xs text-stone-500">
					No quick commands yet.{" "}
					<button
						type="button"
						onClick={onOpenManager}
						className="text-blue-600 hover:underline"
					>
						Open manager
					</button>{" "}
					to add some.
				</span>
			)}
			{commands.map((cmd) => (
				<button
					key={cmd.name}
					type="button"
					onClick={() => onInsert(cmd.name)}
					title={cmd.description ? `${cmd.description}\n\n${cmd.prompt}` : cmd.prompt}
					className="group inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-stone-300 bg-white text-stone-700 hover:border-blue-400 hover:text-blue-700"
				>
					<span>/{cmd.name}</span>
					<span
						role="button"
						tabIndex={0}
						aria-label={`Delete ${cmd.name}`}
						className="ml-1 text-stone-400 hover:text-red-600 opacity-0 group-hover:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							void handleDelete(cmd.name);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								e.stopPropagation();
								void handleDelete(cmd.name);
							}
						}}
					>
						<X size={12} />
					</span>
				</button>
			))}
			{adding ? (
				<AddCommandRow
					existing={commands}
					onSave={handleAddSave}
					onCancel={handleAddCancel}
				/>
			) : (
				<button
					type="button"
					onClick={handleAddClick}
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-dashed border-stone-300 text-stone-500 hover:border-blue-400 hover:text-blue-600"
					aria-label="Add quick command"
				>
					<Plus size={12} />
					Add
				</button>
			)}
			<button
				type="button"
				onClick={onOpenManager}
				className="ml-auto text-xs text-stone-500 hover:text-blue-600 hover:underline"
			>
				Manage
			</button>
		</div>
	);
}

interface AddCommandRowProps {
	existing: QuickCommand[];
	onSave: (next: QuickCommand[]) => Promise<void>;
	onCancel: () => void;
}

function AddCommandRow({ existing, onSave, onCancel }: AddCommandRowProps) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [prompt, setPrompt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const trimmedName = name.trim();
	const candidate: QuickCommand = { name: trimmedName, description: description.trim() || undefined, prompt };
	const validation = validateQuickCommand(candidate, existing);

	const handleSave = useCallback(async () => {
		setError(null);
		if (validation) {
			setError(validation);
			return;
		}
		setSaving(true);
		try {
			await onSave([...existing, candidate]);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setSaving(false);
		}
	}, [validation, onSave, existing, candidate]);

	return (
		<div className="flex flex-col gap-1 w-full mt-1 p-2 rounded border border-blue-300 bg-white">
			<div className="flex flex-wrap items-center gap-2">
				<input
					autoFocus
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="name (e.g. review)"
					className="px-2 py-1 text-xs rounded border border-stone-300 w-40"
					aria-label="Command name"
				/>
				<input
					type="text"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="description (optional)"
					className="px-2 py-1 text-xs rounded border border-stone-300 w-60"
					aria-label="Command description"
				/>
			</div>
			<textarea
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
				placeholder={'prompt (use $ARG for the user-supplied argument)'}
				className="px-2 py-1 text-xs rounded border border-stone-300 w-full resize-y"
				rows={2}
				aria-label="Command prompt"
			/>
			{error && <div className="text-xs text-red-600">{error}</div>}
			{validation && <div className="text-xs text-amber-600">{validation}</div>}
			<div className="flex gap-2">
				<button
					type="button"
					onClick={() => void handleSave()}
					disabled={saving || !!validation}
					className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
				>
					<Check size={12} />
					Save
				</button>
				<button
					type="button"
					onClick={onCancel}
					className="px-2 py-1 text-xs rounded border border-stone-300 text-stone-600 hover:border-stone-400"
				>
					Cancel
				</button>
			</div>
		</div>
	);
}