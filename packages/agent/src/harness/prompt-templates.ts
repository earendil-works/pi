import { parse } from "yaml";
import { type ExecutionEnv, type FileInfo, type PromptTemplate, type Result, toError } from "./types.ts";

export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";

/** 加载 prompt template 时产生的警告。 */
export interface PromptTemplateDiagnostic {
	/** 诊断严重级别。目前仅发出警告。 */
	type: "warning";
	/** 稳定的诊断代码。 */
	code: PromptTemplateDiagnosticCode;
	/** 人类可读的诊断消息。 */
	message: string;
	/** 与诊断关联的路径。 */
	path: string;
}

/** 从 prompt template markdown 文件解析出的 YAML frontmatter 的结构。 */
interface PromptTemplateFrontmatter {
	/** 在斜杠命令菜单中显示的人类可读描述。 */
	description?: string;
	/** 用户调用接受参数的命令时显示的占位提示。 */
	"argument-hint"?: string;
	/** 允许任意额外的 frontmatter 键用于应用特定元数据。 */
	[key: string]: unknown;
}

/**
 * 从一个或多个路径加载 prompt template。
 *
 * 目录输入非递归地加载直接子级 `.md` 文件。文件输入加载显式的 `.md` 文件。缺失路径和
 * 非 markdown 文件会被跳过。读取和解析失败以诊断信息形式返回。
 */
export async function loadPromptTemplates(
	env: ExecutionEnv,
	paths: string | string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	for (const path of Array.isArray(paths) ? paths : [paths]) {
		const infoResult = await env.fileInfo(path);
		if (!infoResult.ok) {
			if (infoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: infoResult.error.message,
					path,
				});
			}
			continue;
		}
		const info = infoResult.value;
		const kind = await resolveKind(env, info, diagnostics);
		if (kind === "directory") {
			const result = await loadTemplatesFromDir(env, info.path);
			promptTemplates.push(...result.promptTemplates);
			diagnostics.push(...result.diagnostics);
		} else if (kind === "file" && info.name.endsWith(".md")) {
			const result = await loadTemplateFromFile(env, info.path);
			if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
			diagnostics.push(...result.diagnostics);
		}
	}
	return { promptTemplates, diagnostics };
}

/**
 * 从带 source 标记的路径加载 prompt template。
 *
 * Source 值被原样保留并附加到每个加载的 prompt template 和诊断信息上。agent 包不解释 source 值；
 * 应用程序自行定义其来源形状。
 */
export async function loadSourcedPromptTemplates<TSource, TPromptTemplate extends PromptTemplate = PromptTemplate>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
): Promise<{
	promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
	diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
}> {
	const promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }> = [];
	const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadPromptTemplates(env, input.path);
		for (const promptTemplate of result.promptTemplates) {
			promptTemplates.push({
				promptTemplate: mapPromptTemplate
					? mapPromptTemplate(promptTemplate, input.source)
					: (promptTemplate as TPromptTemplate),
				source: input.source,
			});
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { promptTemplates, diagnostics };
}

/**
 * 从单个目录加载所有 `.md` prompt template（非递归）。
 *
 * 条目按名称字母顺序排序。仅加载直接子级中的普通 `.md` 文件；
 * 子目录和非 markdown 文件会被跳过。读取和解析失败以诊断信息形式返回。
 */
async function loadTemplatesFromDir(
	env: ExecutionEnv,
	dir: string,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: entriesResult.error.message,
			path: dir,
		});
		return { promptTemplates, diagnostics };
	}
	const entries = entriesResult.value;

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file" || !entry.name.endsWith(".md")) continue;
		const result = await loadTemplateFromFile(env, entry.path);
		if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
		diagnostics.push(...result.diagnostics);
	}
	return { promptTemplates, diagnostics };
}

/**
 * 将单个 `.md` 文件加载为 prompt template。
 *
 * 解析 YAML frontmatter 获取描述；回退到正文的第一个非空行
 * （截断到 60 个字符）。读取或解析失败时返回 `null` promptTemplate，
 * 并附带描述每次失败的诊断信息。
 */
async function loadTemplateFromFile(
	env: ExecutionEnv,
	filePath: string,
): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
	const diagnostics: PromptTemplateDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: rawContent.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const parsed = parseFrontmatter<PromptTemplateFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({
			type: "warning",
			code: "parse_failed",
			message: parsed.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const firstLine = body.split("\n").find((line) => line.trim());
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description && firstLine) {
		description = firstLine.slice(0, 60);
		if (firstLine.length > 60) description += "...";
	}
	return {
		promptTemplate: {
			name: basenameEnvPath(filePath).replace(/\.md$/i, ""),
			description,
			content: body,
		},
		diagnostics,
	};
}

/**
 * 解析符号链接的真实文件系统类型（`"file"` 或 `"directory"`）。
 *
 * 如果 `info.kind` 已已知，则直接返回。否则通过 `canonicalPath` 解析符号链接目标
 * 并重新 stat。当目标无法确定或不存在时返回 `undefined`，
 * 并为非 not-found 错误附加诊断信息。
 */
async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: PromptTemplateDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

/**
 * 从 markdown 内容中解析 YAML frontmatter。
 *
 * 期望文档以单独一行的 `---` 开头。frontmatter 块从第二行开始，到下一个 `---` 行结束。
 * 如果未找到开头的 `---` 或缺少闭合分隔符，则返回空的 frontmatter 对象，并将全部内容视为正文。
 * 解析前行尾符会被规范化（`\r\n` 和 `\r` 转换为 `\n`）。YAML 块使用 `yaml` 库解析；
 * 解析错误会被捕获并以 `Result` 错误形式返回。
 */
function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

/**
 * 从环境风格路径中提取 basename。
 *
 * 去除尾部斜杠，然后返回最后一个 `/` 之后的所有内容。当没有 `/` 时返回整个字符串。
 * 这模拟了 POSIX 风格路径的 `basename(1)` 行为。
 */
function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

/**
 * 使用 shell 风格的引号将参数字符串解析为位置标记。
 *
 * 按未引用的空白字符（空格和制表符）分割。单引号（`'...'`）和双引号
 * （`"..."`）段会抑制分割和转义：引号字符本身被去除，
 * 引号之间的所有内容按原样保留。连续的空白分隔符会被折叠
 * （不会产生空参数）。未匹配的引号被视为在输入末尾闭合。
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

/**
 * 用命令参数替换 prompt template 中的占位符。
 *
 * 可识别的占位符：
 * - `$N`（例如 `$1`、`$2`）：替换为第 N 个位置参数（从 1 开始）。缺失的参数
 *   变为空字符串。
 * - `$@` 和 `$ARGUMENTS`：替换为所有参数以单个空格连接。
 * - `${@:N}`：替换为从位置 N（从 1 开始）到末尾的所有参数，以空格连接。
 *   N 会被限制在第一个参数范围内。
 * - `${@:N:L}`：替换为从位置 N 开始、最多取 L 个参数，以空格连接。
 *   N 会被限制在第一个参数范围内。
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

/** 使用位置参数格式化 prompt template 调用。 */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
