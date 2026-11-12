// Parses model-authored HTML into terminal form fields and validates submitted answers.
/// <reference lib="dom" />

import { Worker } from "node:worker_threads";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export type FormAnswers = Record<string, string | number | string[]>;
export type FormOption = { label: string; value: string; checked: boolean; required: boolean };
export type FormField = {
	name: string;
	label: string;
	kind: "text" | "textarea" | "number" | "date" | "email" | "url" | "radio" | "checkbox" | "select";
	multiple: boolean;
	required: boolean;
	options: FormOption[];
	value: string;
	placeholder: string;
	min?: string;
	max?: string;
	step?: string;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
};
export type FormBlock =
	| { kind: "markdown"; text: string }
	| { kind: "field"; index: number }
	| { kind: "image"; source: string; alt: string };
export type QuestionForm = { fields: FormField[]; blocks: FormBlock[] };
export type FormValue = { text: string; selected: Set<number>; other: string; useOther: boolean };
export type FormValidation =
	| { kind: "valid"; answers: FormAnswers }
	| { kind: "invalid"; field: number; message: string };

/** Accepts a bounded, semantic HTML form; executable or unsupported controls are rejected. */
export function parseQuestionForm(html: string): QuestionForm {
	if (Buffer.byteLength(html) > 65_536) throw new Error("Form HTML exceeds 64 KiB");
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	if (document.querySelector("script,style,[style],button,iframe,object,embed,svg")) {
		throw new Error("Use semantic HTML only: scripts, styles, buttons, embedded documents and SVG are unsupported");
	}
	const forms = document.querySelectorAll("form");
	if (forms.length !== 1) throw new Error("Provide exactly one <form>");
	const form = forms[0];
	const fields: FormField[] = [];
	const controls = new Map<Element, number>();
	const names = new Map<string, number>();
	for (const element of form.querySelectorAll("input,textarea,select")) {
		if (element.hasAttribute("disabled") || element.closest("fieldset[disabled]")) continue;
		const name = element.getAttribute("name")?.trim();
		if (!name) throw new Error("Each form control needs a nonempty name");
		const tag = element.localName;
		const kind = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : tag;
		if (
			kind !== "text" &&
			kind !== "textarea" &&
			kind !== "number" &&
			kind !== "date" &&
			kind !== "email" &&
			kind !== "url" &&
			kind !== "radio" &&
			kind !== "checkbox" &&
			kind !== "select"
		) {
			throw new Error(`Unsupported input type: ${kind}`);
		}
		if (element.hasAttribute("readonly")) throw new Error("Readonly controls are unsupported; use text for context");
		const id = element.getAttribute("id");
		const label =
			Array.from(form.querySelectorAll("label")).find((candidate) => id && candidate.getAttribute("for") === id) ??
			element.closest("label");
		let labelText = element.getAttribute("aria-label") ?? name;
		if (label) {
			// Clone only to remove control defaults from the label without mutating the parsed form.
			const labelCopy = label.cloneNode(true) as Element;
			for (const control of labelCopy.querySelectorAll("input,textarea,select")) control.remove();
			labelText = labelCopy.textContent ?? labelText;
		}
		labelText = cleanText(labelText).trim();
		const existing = names.get(name);
		const choice = kind === "radio" || kind === "checkbox";
		if (existing !== undefined) {
			const field = fields[existing];
			if (!choice || field.kind !== kind) throw new Error(`Incompatible controls share name: ${name}`);
			field.options.push({
				label: labelText,
				value: element.getAttribute("value") ?? "on",
				checked: element.hasAttribute("checked"),
				required: element.hasAttribute("required"),
			});
			field.required ||= element.hasAttribute("required");
			controls.set(element, existing);
			continue;
		}
		const options: FormOption[] = choice
			? [
					{
						label: labelText,
						value: element.getAttribute("value") ?? "on",
						checked: element.hasAttribute("checked"),
						required: element.hasAttribute("required"),
					},
				]
			: kind === "select"
				? Array.from(element.querySelectorAll("option"))
						.filter((option) => !option.hasAttribute("disabled") && !option.closest("optgroup[disabled]"))
						.map((option) => ({
							label: cleanText(option.textContent ?? "").trim(),
							value: option.getAttribute("value") ?? option.textContent ?? "",
							checked: option.hasAttribute("selected"),
							required: false,
						}))
				: [];
		const group = element.closest("fieldset")?.querySelector("legend");
		const field: FormField = {
			name,
			label: choice ? cleanText(group?.textContent ?? name).trim() : labelText,
			kind,
			multiple: kind === "checkbox" || (kind === "select" && element.hasAttribute("multiple")),
			required: element.hasAttribute("required"),
			options,
			value: cleanText(kind === "textarea" ? (element.textContent ?? "") : (element.getAttribute("value") ?? "")),
			placeholder: cleanText(element.getAttribute("placeholder") ?? ""),
			min: element.getAttribute("min") ?? undefined,
			max: element.getAttribute("max") ?? undefined,
			step: element.getAttribute("step") ?? undefined,
			minLength: lengthConstraint(element.getAttribute("minlength")),
			maxLength: lengthConstraint(element.getAttribute("maxlength")),
			pattern: element.getAttribute("pattern") ?? undefined,
		};
		if (field.pattern !== undefined) new RegExp(`^(?:${field.pattern})$`, "v");
		if (field.kind === "number") {
			for (const constraint of [field.min, field.max]) {
				if (constraint !== undefined && (!constraint.trim() || !Number.isFinite(Number(constraint)))) {
					throw new Error(`Invalid numeric bound for ${name}`);
				}
			}
			if (
				field.step !== undefined &&
				field.step !== "any" &&
				(!Number.isFinite(Number(field.step)) || Number(field.step) <= 0)
			) {
				throw new Error(`Invalid numeric step for ${name}`);
			}
			if (field.min !== undefined && field.max !== undefined && Number(field.min) > Number(field.max)) {
				throw new Error(`Minimum exceeds maximum for ${name}`);
			}
		}
		names.set(name, fields.length);
		controls.set(element, fields.length);
		fields.push(field);
	}
	if (!fields.length || fields.length > 64) throw new Error("A form needs between 1 and 64 fields");
	for (const field of fields) {
		if (field.options.length > 256) throw new Error(`Too many options: ${field.name}`);
		if (new Set(field.options.map((option) => option.value)).size !== field.options.length)
			throw new Error(`Option values must be unique: ${field.name}`);
	}
	const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	markdown.addRule("tables", {
		filter: "table",
		replacement: (_content, node) => {
			const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
				Array.from(row.querySelectorAll("th,td")).map((cell) =>
					cleanText(cell.textContent ?? "")
						.trim()
						.replace(/\|/g, "\\|")
						.replace(/\s*\n\s*/g, " "),
				),
			);
			if (!rows.length) return "";
			const width = Math.max(...rows.map((row) => row.length));
			const lines = rows.map(
				(row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`,
			);
			lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
			return `\n\n${lines.join("\n")}\n\n`;
		},
	});
	const blocks: FormBlock[] = [];
	const emitted = new Set<number>();
	const walk = (node: Node): void => {
		if (node.nodeType === 3) {
			const text = cleanText(node.textContent ?? "").trim();
			if (text) blocks.push({ kind: "markdown", text });
			return;
		}
		if (node.nodeType !== 1) return;
		// DOM nodeType does not narrow Node to Element in TypeScript.
		const element = node as Element;
		const index = controls.get(element);
		if (index !== undefined) {
			if (!emitted.has(index)) blocks.push({ kind: "field", index });
			emitted.add(index);
			return;
		}
		if (element.matches("input,textarea,select,label,legend")) {
			for (const control of element.querySelectorAll("input,textarea,select")) walk(control);
			return;
		}
		if (element.localName === "img") {
			const source = element.getAttribute("src");
			if (!source) throw new Error("Images need a src");
			blocks.push({ kind: "image", source, alt: cleanText(element.getAttribute("alt") ?? "Image") });
			return;
		}
		if (!element.querySelector("input,textarea,select,img")) {
			const text = markdown.turndown(element.outerHTML).trim();
			if (text) blocks.push({ kind: "markdown", text: cleanText(text) });
			return;
		}
		for (const child of element.childNodes) walk(child);
	};
	for (const node of form.childNodes) walk(node);
	if (blocks.filter((block) => block.kind === "image").length > 8) throw new Error("A form supports at most 8 images");
	return { fields, blocks };
}

/** Creates editable defaults without accepting or submitting them. */
export function initialFormValues(form: QuestionForm): FormValue[] {
	return form.fields.map((field) => {
		const selected = field.options.flatMap((option, index) => (option.checked ? [index] : []));
		if (!field.multiple && selected.length > 1) selected.splice(0, selected.length - 1);
		return { text: field.value, selected: new Set(selected), other: "", useOther: false };
	});
}

/** Validates explicit submission, returning typed values or the first actionable field error. */
export async function validateForm(
	form: QuestionForm,
	values: FormValue[],
	signal?: AbortSignal,
): Promise<FormValidation> {
	const entries: [string, string | number | string[]][] = [];
	const patterns: { field: number; pattern: string; value: string }[] = [];
	for (let index = 0; index < form.fields.length; index++) {
		const field = form.fields[index];
		const value = values[index];
		const invalid = (message: string): FormValidation => ({
			kind: "invalid",
			field: index,
			message: `${field.label}: ${message}`,
		});
		if (field.options.length || field.kind === "radio" || field.kind === "checkbox" || field.kind === "select") {
			const selected = field.options.flatMap((option, optionIndex) =>
				value.selected.has(optionIndex) ? [option.value] : [],
			);
			if (value.useOther) {
				if (!value.other.trim()) return invalid("enter your custom answer or deselect Other");
				selected.push(value.other);
			}
			if (field.required && (!selected.length || (field.kind === "select" && selected.every((item) => !item))))
				return invalid("an answer is required");
			if (
				field.kind === "checkbox" &&
				field.options.some((option, optionIndex) => option.required && !value.selected.has(optionIndex))
			)
				return invalid("select the required checkbox");
			if (!selected.length) continue;
			entries.push([
				field.name,
				field.kind === "checkbox" && field.options.length === 1
					? selected[0]
					: field.multiple
						? selected
						: selected[0],
			]);
			continue;
		}
		const text = value.text;
		if (field.required && !text.length) return invalid("an answer is required");
		if (text) {
			if (field.minLength !== undefined && text.length < field.minLength)
				return invalid(`use at least ${field.minLength} characters`);
			if (field.maxLength !== undefined && text.length > field.maxLength)
				return invalid(`use at most ${field.maxLength} characters`);
			if (field.kind === "number") {
				if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text)))
					return invalid("enter a finite number");
				const number = Number(text);
				if (field.min !== undefined && number < Number(field.min)) return invalid(`minimum is ${field.min}`);
				if (field.max !== undefined && number > Number(field.max)) return invalid(`maximum is ${field.max}`);
				const step = field.step === "any" ? undefined : Number(field.step ?? 1);
				const offset = (number - Number(field.min ?? 0)) / (step ?? 1);
				if (step !== undefined && step > 0 && Math.abs(offset - Math.round(offset)) > 1e-8)
					return invalid(`use steps of ${step}`);
			}
			if (field.kind === "date") {
				const date = new Date(`${text}T00:00:00Z`);
				if (
					!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
					!Number.isFinite(date.getTime()) ||
					date.toISOString().slice(0, 10) !== text
				)
					return invalid("use a valid YYYY-MM-DD date");
				if ((field.min && text < field.min) || (field.max && text > field.max))
					return invalid(`date must be between ${field.min ?? "any"} and ${field.max ?? "any"}`);
			}
			if (field.kind === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return invalid("enter an email address");
			if (field.kind === "url") {
				try {
					new URL(text);
				} catch {
					return invalid("enter an absolute URL");
				}
			}
			if (field.pattern !== undefined) patterns.push({ field: index, pattern: field.pattern, value: text });
		}
		if (field.kind === "number" && !text) continue;
		entries.push([field.name, field.kind === "number" ? Number(text) : text]);
	}
	if (patterns.length) {
		const matches = await matchPatterns(patterns, signal);
		const failed = matches.findIndex((match) => !match);
		if (failed !== -1)
			return {
				kind: "invalid",
				field: patterns[failed].field,
				message: `${form.fields[patterns[failed].field].label}: does not match the required pattern`,
			};
	}
	return { kind: "valid", answers: Object.fromEntries(entries) };
}

function cleanText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function lengthConstraint(value: string | null): number | undefined {
	if (value === null) return undefined;
	if (!/^\d+$/.test(value)) throw new Error(`Invalid length constraint: ${value}`);
	return Number(value);
}

function matchPatterns(patterns: { pattern: string; value: string }[], signal?: AbortSignal): Promise<boolean[]> {
	// Model-authored regexes run off the UI thread so pathological backtracking cannot freeze the terminal.
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			'const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage(workerData.map(({pattern,value})=>new RegExp("^(?:"+pattern+")$","v").test(value)));',
			{ eval: true, workerData: patterns },
		);
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			void worker.terminate();
		};
		const fail = (error: Error) => {
			cleanup();
			reject(error);
		};
		const abort = () => fail(new Error("Form validation cancelled"));
		const timeout = setTimeout(
			() => fail(new Error("Pattern validation exceeded one second; simplify the form pattern")),
			1000,
		);
		worker.once("message", (result: boolean[]) => {
			cleanup();
			resolve(result);
		});
		worker.once("error", fail);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
