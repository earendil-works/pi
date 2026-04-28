import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Loader2, Paperclip, Send, Sparkles, Square } from "lucide";
import { type Attachment, loadAttachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

interface SlashCommand {
	name: string;
	description: string;
	source: "builtin" | "skill" | string;
}

// Fetched once per page load — no-store ensures we bypass HTTP cache.
let fetchPromise: Promise<SlashCommand[]> | null = null;
async function fetchSlashCommands(): Promise<SlashCommand[]> {
	if (fetchPromise) return fetchPromise;

	fetchPromise = fetch("/api/agent/commands", { cache: "no-store" })
		.then(async (res) => {
			if (!res.ok) return [];
			const data = (await res.json()) as { builtins: SlashCommand[]; skills: SlashCommand[] };
			return [...data.builtins, ...data.skills.map((s) => ({ ...s, name: `skill:${s.name}` }))];
		})
		.catch(() => {
			fetchPromise = null;
			return [] as SlashCommand[];
		});

	return fetchPromise;
}

/** Call this to force the next popup open to re-fetch from the server. */
export function invalidateSlashCommandCache() {
	fetchPromise = null;
}

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}

	@property() isStreaming = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() attachments: Attachment[] = [];
	@property() maxFiles = 10;
	@property() maxFileSize = 20 * 1024 * 1024; // 20MB
	@property() acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";

	@state() processingFiles = false;
	@state() isDragging = false;
	@state() private slashCommands: SlashCommand[] = [];
	@state() private slashQuery = "";
	@state() private slashActive = false;
	@state() private slashIndex = 0;
	private fileInputRef = createRef<HTMLInputElement>();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private get slashFiltered(): SlashCommand[] {
		if (!this.slashActive) return [];
		const q = this.slashQuery.toLowerCase();
		return this.slashCommands.filter(
			(c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
		);
	}

	private handleTextareaInput = async (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.onInput?.(this.value);

		// Slash command detection: active when text starts with "/" and no spaces yet
		if (this.value.startsWith("/") && !this.value.includes(" ") && !this.value.includes("\n")) {
			// Ensure commands are loaded (only fetches once per page load)
			if (!this.slashActive) {
				const cmds = await fetchSlashCommands();
				// Re-read this.value after the await — user may have typed more
				if (this.value.startsWith("/") && !this.value.includes(" ") && !this.value.includes("\n")) {
					this.slashCommands = cmds;
					this.slashActive = true;
					this.slashQuery = this.value.slice(1);
					this.slashIndex = 0;
				}
				// If user typed a space or cleared while we were fetching, do nothing
				return;
			}
			// Already active — just update the query filter synchronously
			const newQuery = this.value.slice(1);
			if (this.slashQuery !== newQuery) {
				this.slashQuery = newQuery;
				this.slashIndex = 0;
			}
		} else {
			this.slashActive = false;
		}
	};

	private selectSlashCommand(cmd: SlashCommand) {
		this.value = `/${cmd.name} `;
		this.slashActive = false;
		// Sync to textarea DOM value and move cursor to end
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.value = this.value;
			textarea.focus();
			textarea.setSelectionRange(this.value.length, this.value.length);
		}
		this.onInput?.(this.value);
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		// Ignore key events during IME composition (e.g. CJK input)
		if (e.isComposing || e.key === "Process") return;

		// Slash palette navigation
		if (this.slashActive && this.slashFiltered.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.slashIndex = (this.slashIndex + 1) % this.slashFiltered.length;
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.slashIndex = (this.slashIndex - 1 + this.slashFiltered.length) % this.slashFiltered.length;
				return;
			}
			if (e.key === "Tab" || (e.key === "Enter" && this.slashActive)) {
				e.preventDefault();
				this.selectSlashCommand(this.slashFiltered[this.slashIndex]);
				return;
			}
		}
		if (e.key === "Escape" && this.slashActive) {
			e.preventDefault();
			this.slashActive = false;
			return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.isStreaming && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private handlePaste = async (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];

		// Check for image items in clipboard
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		// If we found images, process them
		if (imageFiles.length > 0) {
			e.preventDefault(); // Prevent default paste behavior

			if (imageFiles.length + this.attachments.length > this.maxFiles) {
				alert(`Maximum ${this.maxFiles} files allowed`);
				return;
			}

			this.processingFiles = true;
			const newAttachments: Attachment[] = [];

			for (const file of imageFiles) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`Image exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}

					const attachment = await loadAttachment(file);
					newAttachments.push(attachment);
				} catch (error) {
					console.error("Error processing pasted image:", error);
					alert(`Failed to process pasted image: ${String(error)}`);
				}
			}

			this.attachments = [...this.attachments, ...newAttachments];
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	private handleSend = () => {
		this.onSend?.(this.value, this.attachments);
	};

	private handleAttachmentClick = () => {
		this.fileInputRef.value?.click();
	};

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			input.value = "";
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
	};

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	override updated(changedProps: Map<string, unknown>) {
		// Scroll active slash command item into view when index changes
		if (changedProps.has("slashIndex") && this.slashActive) {
			const active = this.querySelector(`[data-slash-idx="${this.slashIndex}"]`);
			active?.scrollIntoView({ block: "nearest" });
		}
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				<!-- Attachments -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2">
								${this.attachments.map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
							</div>
						`
						: ""
				}

				<!-- Slash command palette -->
				${
					this.slashActive && this.slashFiltered.length > 0
						? html`
							<div
								class="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg z-50 overflow-hidden"
							>
								<div class="max-h-64 overflow-y-auto">
									${this.slashFiltered.map(
										(cmd, i) => html`
											<div
												data-slash-idx=${i}
												class="flex items-baseline gap-3 px-3 py-2 cursor-pointer text-sm transition-colors
													${i === this.slashIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}"
												@mousedown=${(e: Event) => {
													e.preventDefault();
													this.selectSlashCommand(cmd);
												}}
												@mousemove=${() => {
													this.slashIndex = i;
												}}
											>
												<span class="font-mono font-medium text-primary shrink-0">/${cmd.name}</span>
												<span class="text-muted-foreground truncate">${cmd.description}</span>
												${
													cmd.source === "skill"
														? html`<span class="ml-auto text-xs text-muted-foreground shrink-0 opacity-60">skill</span>`
														: ""
												}
											</div>
										`,
									)}
								</div>
								<div class="px-3 py-1.5 border-t border-border flex gap-3 text-xs text-muted-foreground bg-muted/30">
									<span>↑↓ ${i18n("navigate")}</span>
									<span>↵ / Tab ${i18n("select")}</span>
									<span>Esc ${i18n("dismiss")}</span>
								</div>
							</div>
						`
						: ""
				}

				<textarea
					class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
					placeholder=${i18n("Type a message...")}
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${this.value}
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					@paste=${this.handlePaste}
					${ref(this.textareaRef)}
				></textarea>

				<!-- Hidden file input -->
				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

				<!-- Button Row -->
				<div class="px-2 pb-2 flex items-center justify-between">
					<!-- Left side - attachment and thinking selector -->
					<div class="flex gap-2 items-center">
						${
							this.showAttachmentButton
								? this.processingFiles
									? html`
										<div class="h-8 w-8 flex items-center justify-center">
											${icon(Loader2, "sm", "animate-spin text-muted-foreground")}
										</div>
									`
									: html`
										${Button({
											variant: "ghost",
											size: "icon",
											className: "h-8 w-8",
											onClick: this.handleAttachmentClick,
											children: icon(Paperclip, "sm"),
										})}
									`
								: ""
						}
						${
							supportsThinking && this.showThinkingSelector
								? html`
									${Select({
										value: this.thinkingLevel,
										placeholder: i18n("Off"),
										options: [
											{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
											{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
											{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
											{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
											{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
										] as SelectOption[],
										onChange: (value: string) => {
											const level = value as "off" | "minimal" | "low" | "medium" | "high";
											this.thinkingLevel = level;
											this.onThinkingChange?.(level);
										},
										width: "80px",
										size: "sm",
										variant: "ghost",
										fitContent: true,
									})}
								`
								: ""
						}
					</div>

					<!-- Model selector and send on the right -->
					<div class="flex gap-2 items-center">
						${
							this.showModelSelector && this.currentModel
								? html`
									${Button({
										variant: "ghost",
										size: "sm",
										onClick: () => {
											// Focus textarea before opening model selector so focus returns there
											this.textareaRef.value?.focus();
											// Wait for next frame to ensure focus takes effect before dialog captures it
											requestAnimationFrame(() => {
												this.onModelSelect?.();
											});
										},
										children: html`
											${icon(Sparkles, "sm")}
											<span class="ml-1">${this.currentModel.id}</span>
										`,
										className: "h-8 text-xs truncate",
									})}
								`
								: ""
						}
						${
							this.isStreaming
								? html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.onAbort,
										children: icon(Square, "sm"),
										className: "h-8 w-8",
									})}
								`
								: html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.handleSend,
										disabled: (!this.value.trim() && this.attachments.length === 0) || this.processingFiles,
										children: html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`,
										className: "h-8 w-8",
									})}
								`
						}
					</div>
				</div>
			</div>
		`;
	}
}
