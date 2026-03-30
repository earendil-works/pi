import { Container, Input, type SelectItem, SelectList, Spacer, Text } from "@kennyfrc/mu-tui";
import { getSelectListTheme, theme } from "../../theme/theme.js";
import { sanitizeScopeName } from "./storage.js";
import type { AskUserAnswer, AskUserAnswerSource, AskUserRequest, AskUserResult } from "./types.js";

interface AskUserDialogComponentOptions {
	request: AskUserRequest;
	onSubmit: (result: AskUserResult) => void;
	onCancel: () => void;
}

type DialogStage = "scope" | "choice" | "custom";

const CUSTOM_VALUE = "__custom__";

function buildSummary(answers: AskUserAnswer[]): string {
	if (answers.length === 0) return "No answers captured.";
	return answers.map((answer, index) => `${index + 1}. ${answer.topic}: ${answer.answer}`).join("\n");
}

export class AskUserDialogComponent extends Container {
	private readonly request: AskUserRequest;
	private readonly scopeInput = new Input();
	private readonly customInput = new Input();
	private readonly onSubmitCallback: (result: AskUserResult) => void;
	private readonly onCancelCallback: () => void;

	private stage: DialogStage = "scope";
	private scopeName = "";
	private scopePreview = "";
	private questionIndex = 0;
	private currentSelectList: SelectList | null = null;
	private answers: AskUserAnswer[] = [];
	private errorMessage: string | null = null;

	constructor(options: AskUserDialogComponentOptions) {
		super();
		this.request = options.request;
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;

		this.scopeInput.setValue(options.request.scopeName ?? "");
		this.scopePreview = this.scopeInput.getValue().trim();
		this.scopeInput.onSubmit = () => this.commitScope();
		this.customInput.onSubmit = () => this.commitCustomAnswer();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					this.request.mode === "validation_contract"
						? "Capture the missing validation contract details."
						: "Capture the missing specification details.",
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(this.request.objective), 0, 0));
		this.addChild(new Spacer(1));

		if (this.errorMessage) {
			this.addChild(new Text(theme.fg("warning", this.errorMessage), 0, 0));
			this.addChild(new Spacer(1));
		}

		if (this.stage === "scope") {
			this.addChild(new Text("Scope name", 0, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						this.scopePreview.trim()
							? `Stored under devdocs/scopes/${this.scopePreview.trim()}`
							: "Choose the durable subfolder name for this clarification scope.",
					),
					0,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addChild(this.scopeInput);
			return;
		}

		this.addChild(new Text(theme.fg("accent", `Scope: ${this.scopeName}`), 0, 0));
		this.addChild(new Spacer(1));

		const question = this.request.questions[this.questionIndex];
		if (!question) {
			return;
		}

		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Question ${this.questionIndex + 1} of ${this.request.questions.length} · ${question.topic}`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(question.prompt, 0, 0));
		this.addChild(new Spacer(1));

		if (this.stage === "choice") {
			this.currentSelectList = this.buildSelectList(question);
			this.addChild(this.currentSelectList);
			return;
		}

		this.currentSelectList = null;
		this.addChild(new Text(theme.fg("muted", "Type a custom answer and press Enter."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.customInput);
	}

	private buildSelectList(question: AskUserRequest["questions"][number]): SelectList {
		const items: SelectItem[] = question.options.map((option) => ({
			value: option,
			label: option,
		}));

		items.push({
			value: CUSTOM_VALUE,
			label: "Custom answer…",
			description: "Type your own answer",
		});

		const selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 6), getSelectListTheme(), 40);
		selectList.onSelect = (item) => {
			if (item.value === CUSTOM_VALUE) {
				this.stage = "custom";
				this.customInput.setValue("");
				this.errorMessage = null;
				this.rebuild();
				return;
			}
			this.commitAnswer(item.value, "option");
		};
		selectList.onCancel = () => this.onCancelCallback();
		return selectList;
	}

	private commitScope(): void {
		const rawScopeName = this.scopeInput.getValue().trim();
		this.scopePreview = rawScopeName;
		try {
			this.scopeName = sanitizeScopeName(rawScopeName);
			this.errorMessage = null;
			this.questionIndex = 0;
			this.stage = this.request.questions[0]?.options.length ? "choice" : "custom";
			this.rebuild();
		} catch (error: unknown) {
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.rebuild();
		}
	}

	private commitCustomAnswer(): void {
		const value = this.customInput.getValue().trim();
		if (!value) {
			this.errorMessage = "Custom answer cannot be empty";
			this.rebuild();
			return;
		}
		this.commitAnswer(value, "custom");
	}

	private commitAnswer(value: string, source: AskUserAnswerSource): void {
		const question = this.request.questions[this.questionIndex];
		if (!question) return;

		this.answers.push({
			questionId: question.id,
			topic: question.topic,
			prompt: question.prompt,
			answer: value,
			source,
			field: question.field,
			entryId: question.entryId,
		});

		this.errorMessage = null;
		this.questionIndex++;
		if (this.questionIndex >= this.request.questions.length) {
			this.onSubmitCallback({
				scopeName: this.scopeName,
				sanitizedScopeName: this.scopeName,
				answers: this.answers,
				files: [],
				summary: buildSummary(this.answers),
			});
			return;
		}

		this.customInput.setValue("");
		this.stage = this.request.questions[this.questionIndex]?.options.length ? "choice" : "custom";
		this.rebuild();
	}

	handleInput(data: string): void {
		// Escape cancels the dialog
		if (data === "\x1b") {
			this.onCancelCallback();
			return;
		}

		// Ctrl+C clears the current input field (does NOT cancel)
		if (data === "\x03") {
			if (this.stage === "scope") {
				this.scopeInput.setValue("");
				this.scopePreview = "";
				this.errorMessage = null;
				this.rebuild();
			} else if (this.stage === "custom") {
				this.customInput.setValue("");
				this.errorMessage = null;
				this.rebuild();
			}
			// In "choice" stage, SelectList handles its own input
			return;
		}

		if (this.stage === "scope") {
			this.scopeInput.handleInput(data);
			this.scopePreview = this.scopeInput.getValue().trim();
			this.errorMessage = null;
			return;
		}

		if (this.stage === "custom") {
			this.customInput.handleInput(data);
			this.errorMessage = null;
			return;
		}

		this.currentSelectList?.handleInput(data);
	}

	invalidate(): void {
		this.currentSelectList?.invalidate();
	}
}
