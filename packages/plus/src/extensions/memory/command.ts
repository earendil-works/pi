/**
 * /memory command: browse, add, edit, and forget per-project memories.
 *
 *   /memory           pick a memory to view/edit in the editor
 *   /memory add       create a memory (name, then body in the editor)
 *   /memory forget    pick a memory to delete
 *   /memory index     show the raw MEMORY.md index
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { parseFrontmatter } from "../../../../coding-agent/src/utils/frontmatter.ts";
import { MEMORY_TYPES, type Memory, type MemoryStore, type MemoryType } from "./store.ts";
import type { MemoryToolsDeps } from "./tools.ts";

const USAGE = "Usage: /memory (browse/edit) | /memory add | /memory forget | /memory index";

function formatOption(memory: Memory): string {
	return `${memory.name} (${memory.type}) — ${memory.description || memory.body.split("\n").find((l) => l.trim()) || "(no description)"}`;
}

async function showIndex(ctx: ExtensionCommandContext, store: MemoryStore): Promise<void> {
	const index = await store.readIndex();
	ctx.ui.notify(index.trim().length > 0 ? index : "No memories saved for this project yet.", "info");
}

async function browse(ctx: ExtensionCommandContext, store: MemoryStore): Promise<void> {
	const memories = await store.list();
	if (memories.length === 0) {
		ctx.ui.notify("No memories saved for this project yet. Use /memory add or the memory_save tool.", "info");
		return;
	}
	const selected = await ctx.ui.select("Select a memory to view/edit", memories.map(formatOption));
	if (selected === undefined) return;
	const memory = memories.find((m) => formatOption(m) === selected);
	if (!memory) return;

	const original = serializeForEdit(memory);
	const edited = await ctx.ui.editor(`Edit memory "${memory.name}" (clear the text and save to cancel)`, original);
	if (edited === undefined) {
		ctx.ui.notify("Edit cancelled.", "info");
		return;
	}
	if (edited.trim() === "") {
		ctx.ui.notify("Memory left unchanged (empty edit).", "info");
		return;
	}
	if (edited === original) {
		ctx.ui.notify("Memory unchanged.", "info");
		return;
	}

	// Accept frontmatter edits from the editor; fall back to the existing
	// fields with the edited text as the body.
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(edited);
	const name = typeof frontmatter.name === "string" && frontmatter.name.trim() !== "" ? frontmatter.name : memory.name;
	const description =
		typeof frontmatter.description === "string" && frontmatter.description.trim() !== ""
			? frontmatter.description
			: memory.description;
	const type = (MEMORY_TYPES as readonly string[]).includes(frontmatter.type as string)
		? (frontmatter.type as MemoryType)
		: memory.type;
	await store.save({ name, description, type, body });
	ctx.ui.notify(`Memory "${name}" saved.`, "info");
}

function serializeForEdit(memory: Memory): string {
	return `---\nname: ${memory.name}\ndescription: ${memory.description}\ntype: ${memory.type}\n---\n\n${memory.body.trim()}\n`;
}

async function add(ctx: ExtensionCommandContext, store: MemoryStore): Promise<void> {
	const name = await ctx.ui.input("Memory name", "e.g. prefers-pnpm");
	if (name === undefined || name.trim() === "") {
		ctx.ui.notify("Memory name is required; nothing saved.", "warning");
		return;
	}
	const trimmedName = name.trim();
	const body = await ctx.ui.editor(`Body of memory "${trimmedName}" (markdown)`);
	if (body === undefined || body.trim() === "") {
		ctx.ui.notify("Memory body is empty; nothing saved.", "warning");
		return;
	}
	const firstLine = body
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	await store.save({
		name: trimmedName,
		description: (firstLine ?? "").slice(0, 80),
		type: "project",
		body,
	});
	ctx.ui.notify(`Memory "${trimmedName}" saved.`, "info");
}

async function forget(ctx: ExtensionCommandContext, store: MemoryStore): Promise<void> {
	const memories = await store.list();
	if (memories.length === 0) {
		ctx.ui.notify("No memories to forget.", "info");
		return;
	}
	const selected = await ctx.ui.select("Select a memory to forget", memories.map(formatOption));
	if (selected === undefined) return;
	const memory = memories.find((m) => formatOption(m) === selected);
	if (!memory) return;
	const confirmed = await ctx.ui.confirm("Forget memory", `Delete "${memory.name}" permanently?`);
	if (!confirmed) {
		ctx.ui.notify("Cancelled.", "info");
		return;
	}
	await store.remove(memory.fileName);
	ctx.ui.notify(`Forgot "${memory.name}".`, "info");
}

export function registerMemoryCommand(pi: ExtensionAPI, deps: MemoryToolsDeps): void {
	pi.registerCommand("memory", {
		description: "Browse, add, or forget per-project long-term memories",
		handler: async (args, ctx) => {
			const store = deps.storeFor(ctx);
			const arg = args.trim();
			if (arg === "") {
				if (ctx.mode !== "tui") {
					// Browsing needs the interactive dialogs; show the index instead.
					await showIndex(ctx, store);
					return;
				}
				await browse(ctx, store);
				return;
			}
			if (arg === "index") {
				await showIndex(ctx, store);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(`${USAGE} — add/forget require interactive mode.`, "warning");
				return;
			}
			if (arg === "add") {
				await add(ctx, store);
				return;
			}
			if (arg === "forget") {
				await forget(ctx, store);
				return;
			}
			ctx.ui.notify(USAGE, "info");
		},
	});
}
