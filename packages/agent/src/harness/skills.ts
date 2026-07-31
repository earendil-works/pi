import ignore from "ignore";
import { parse } from "yaml";
import { type ExecutionEnv, type FileInfo, type Result, type Skill, toError } from "./types.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** 加载技能时产生的警告。 */
export interface SkillDiagnostic {
	/** 诊断严重性。目前仅发出警告。 */
	type: "warning";
	/** 稳定的诊断代码。 */
	code: SkillDiagnosticCode;
	/** 人类可读的诊断消息。 */
	message: string;
	/** 与诊断关联的路径。 */
	path: string;
}

/** 从 SKILL.md 文件解析的 YAML frontmatter。所有字段均为可选，以允许优雅降级。 */
interface SkillFrontmatter {
	/** 技能名称。省略时默认为父目录名称。 */
	name?: string;
	/** 技能描述。没有描述的技能会被静默丢弃。 */
	description?: string;
	/** 为 true 时，技能内容对模型可见，但模型无法直接调用该技能。 */
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/** 格式化技能调用提示词，可选择追加额外的用户指令。 */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * 从一个或多个目录加载技能。
 *
 * 递归遍历目录，加载 `SKILL.md` 文件，加载直接的根级别 `.md` 文件作为技能，遵循忽略文件规则，
 * 并返回无效技能文件的诊断信息。缺失的输入目录会被跳过。
 */
export async function loadSkills(
	env: ExecutionEnv,
	dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await env.fileInfo(dir);
		if (!rootInfoResult.ok) {
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
		const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, ignore(), rootInfo.path);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

/**
 * 从带 source 标记的目录加载技能。
 *
 * source 值会被原样保留并附加到每个加载的技能和诊断信息上。agent 包不解释 source 值；
 * 应用程序定义各自的来源形状。
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<{
	skills: Array<{ skill: TSkill; source: TSource }>;
	diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
	const skills: Array<{ skill: TSkill; source: TSource }> = [];
	const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		const result = await loadSkills(env, input.path);
		for (const skill of result.skills) {
			skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill), source: input.source });
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { skills, diagnostics };
}

/**
 * 递归遍历目录以发现并加载 SKILL.md 文件。
 *
 * 在每个目录层级，函数首先查找 SKILL.md 文件并将其作为该目录的技能定义加载。
 * 当 includeRootFiles 为 true 时，顶层根目录中的独立 .md 文件也会作为技能加载。
 * 递归会跳过名称以点号开头或为 `node_modules` 的条目，同时也会排除匹配累积忽略规则
 * （来自遍历过程中发现的 .gitignore、.ignore 和 .fdignore 文件）的条目。
 *
 * @param env - 提供文件系统访问的执行环境。
 * @param dir - 需要扫描的目录的绝对路径。
 * @param includeRootFiles - 是否将独立的 .md 文件作为技能加载（仅顶层输入目录为 true）。
 * @param ignoreMatcher - 累积的忽略匹配器，携带来自祖先目录的模式。
 * @param rootDir - 用于计算相对忽略路径的顶层技能目录。
 * @returns 加载的技能以及遇到的诊断信息。
 */
async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	includeRootFiles: boolean,
	ignoreMatcher: IgnoreMatcher,
	rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	const dirInfoResult = await env.fileInfo(dir);
	if (!dirInfoResult.ok) {
		if (dirInfoResult.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: dirInfoResult.error.message,
				path: dir,
			});
		}
		return { skills, diagnostics };
	}
	const dirInfo = dirInfoResult.value;
	if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") return { skills, diagnostics };

	await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);

	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
		return { skills, diagnostics };
	}
	const entries = entriesResult.value;

	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file") continue;
		const relPath = relativeEnvPath(rootDir, fullPath);
		if (ignoreMatcher.ignores(relPath)) continue;

		const result = await loadSkillFromFile(env, fullPath);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (!kind) continue;

		const relPath = relativeEnvPath(rootDir, fullPath);
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;

		if (kind === "directory") {
			const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = await loadSkillFromFile(env, fullPath);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

/**
 * 从给定目录读取忽略文件（`.gitignore`、`.ignore`、`.fdignore`）并将其模式合并到累积的忽略匹配器中。
 *
 * 忽略文件中的每个模式行都会加上目录相对于根技能目录的路径前缀，以确保模式无论在哪个子目录中定义
 * 都能正确应用。注释和空行在预处理过程中会被过滤掉。
 *
 * @param env - 提供文件系统访问的执行环境。
 * @param ig - 需要合并模式到的累积忽略匹配器。
 * @param dir - 需要检查忽略文件的目录的绝对路径。
 * @param rootDir - 用于计算相对前缀的顶层技能目录。
 * @param diagnostics - 读取忽略文件时遇到的警告的累积器。
 */
async function addIgnoreRules(
	env: ExecutionEnv,
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = joinEnvPath(dir, filename);
		const info = await env.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		if (info.value.kind !== "file") continue;
		const content = await env.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) ig.add(patterns);
	}
}

/**
 * 预处理单行忽略模式，添加目录前缀使模式相对于根技能目录生效。
 *
 * 开头的 `/` 会被去除（gitignore 模式本身已相对于文件所在位置）。开头的 `!` 否定符号在
 * 前缀转换过程中会被保留。去除空白后为空或纯注释的行返回 null（调用方应将其丢弃）。
 *
 * @param line - 来自忽略文件的一行原始文本。
 * @param prefix - 需要添加的目录前缀，以 `/` 结尾（根目录时为空字符串）。
 * @returns 添加前缀后的模式，如果该行应被跳过则返回 null。
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * 将单个 SKILL.md（或独立的 .md）文件解析为 {@link Skill} 对象。
 *
 * 通过 {@link parseFrontmatter} 提取 YAML frontmatter 和 markdown 正文。技能名称取自 frontmatter 的
 * `name` 字段，如果缺失则回退到父目录名称。当描述缺失或为空时，该技能会被丢弃（返回 null）。
 * `name` 和 `description` 的验证错误会作为诊断信息发出，但不会阻止技能加载（除非描述缺失）。
 *
 * @param env - 提供文件系统访问的执行环境。
 * @param filePath - markdown 技能文件的绝对路径。
 * @returns 解析后的技能（可能为 null）以及诊断信息。
 */
async function loadSkillFromFile(
	env: ExecutionEnv,
	filePath: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const skillDir = dirnameEnvPath(filePath);
	const parentDirName = basenameEnvPath(skillDir);
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	for (const error of validateDescription(description)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			content: body,
			filePath,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * 根据命名约定验证技能名称。
 *
 * 规则：
 * - 必须与父目录名称匹配（除非通过 frontmatter 显式设置）。
 * - 最大长度为 {@link MAX_NAME_LENGTH} 个字符。
 * - 仅允许小写字母（`a-z`）、数字（`0-9`）和连字符（`-`）。
 * - 不能以连字符开头或结尾。
 * - 不能包含连续的连字符（`--`）。
 *
 * @param name - 需要验证的技能名称。
 * @param parentDirName - 用于比较的期望目录名称。
 * @returns 人类可读的错误消息数组（有效时为空）。
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

/**
 * 验证技能描述。
 *
 * 描述为必填项（去除空白后不能为空），且不能超过 {@link MAX_DESCRIPTION_LENGTH} 个字符。
 *
 * @param description - 来自 frontmatter 的描述字符串（可能为 undefined）。
 * @returns 人类可读的错误消息数组（有效时为空）。
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

/**
 * 从 markdown 字符串中解析 YAML frontmatter。
 *
 * 要求 frontmatter 以独立一行的 `---` 开头（位于内容起始处）。闭合的 `---` 必须单独占一行。
 * 当找不到有效的 frontmatter 块时，整个内容将被视为正文，frontmatter 对象为空。
 *
 * @param content - 包含可选 YAML frontmatter 的原始文件内容。
 * @returns 包含解析后的 frontmatter（类型为 T）和剩余 markdown 正文的结果，如果 YAML 解析失败则返回错误。
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
 * 解析文件系统条目的规范类型，当初始类型既不是文件也不是目录时（例如符号链接），会跟踪符号链接。
 *
 * @param env - 提供文件系统访问的执行环境。
 * @param info - 需要解析的条目的文件信息。
 * @param diagnostics - 符号链接解析过程中遇到的警告的累积器。
 * @returns `"file"`、`"directory"`，如果条目无法解析则返回 `undefined`。
 */
async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
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

/** 将基础路径和子名称用单个 `/` 分隔符拼接，规范化多余的斜杠。 */
function joinEnvPath(base: string, child: string): string {
	return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

/** 返回父目录路径，去除末尾斜杠和最后一个路径段。根路径返回 `"/"`。 */
function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex <= 0 ? "/" : normalized.slice(0, slashIndex);
}

/** 返回最后一个路径段（文件或目录名），去除末尾斜杠。 */
function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

/** 计算从 `root` 到 `path` 的相对路径。相等时返回空字符串，否则去除开头的斜杠。 */
function relativeEnvPath(root: string, path: string): string {
	const normalizedRoot = root.replace(/\/+$/, "");
	const normalizedPath = path.replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
