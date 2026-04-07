const TOOL_NAME_ALIASES = {
    exec: "exec_command",
    applypatch: "apply_patch",
    readthread: "read_thread",
    listthreads: "list_threads",
    readimage: "read_image",
    viewimage: "view_image",
    updateplan: "update_plan",
    todowrite: "todo_write",
    container_exec: "exec_command",
};
function baseNormalizeToolName(name) {
    let normalized = name.trim();
    while (normalized.startsWith("functions.")) {
        normalized = normalized.slice("functions.".length);
    }
    normalized = normalized
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[.\s-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
    return TOOL_NAME_ALIASES[normalized] ?? normalized;
}
export function normalizeToolNameWithTools(name, tools) {
    const raw = name.trim();
    if (!raw)
        return raw;
    const normalized = baseNormalizeToolName(raw);
    if (!tools || tools.length === 0)
        return normalized;
    const exact = tools.find((tool) => tool.name === raw);
    if (exact)
        return exact.name;
    const lowerRaw = raw.toLowerCase();
    const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lowerRaw);
    if (caseInsensitive)
        return caseInsensitive.name;
    const normalizedMatch = tools.find((tool) => baseNormalizeToolName(tool.name) === normalized);
    if (normalizedMatch)
        return normalizedMatch.name;
    return normalized;
}
function buildRecoveredToolCallId(toolName, seed) {
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "tool";
    const safeSeed = seed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "block";
    const baseId = `recovered_${safeTool}_${safeSeed}`;
    return `${baseId}|${baseId}`;
}
export function upsertToolCallContent(content, toolCall) {
    const existingIndex = content.findIndex((block) => block.type === "toolCall" && block.id === toolCall.id);
    if (existingIndex !== -1) {
        const existing = content[existingIndex];
        if (existing.type === "toolCall") {
            existing.name = toolCall.name;
            existing.arguments = toolCall.arguments;
        }
        return { contentIndex: existingIndex, inserted: false };
    }
    content.push(toolCall);
    return { contentIndex: content.length - 1, inserted: true };
}
export function recoverToolCallFromTextContent(content, tools, normalizeToolName, parseArguments) {
    if (!tools || tools.length === 0)
        return null;
    const availableToolNames = new Set(tools.map((tool) => tool.name));
    for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (block.type !== "text")
            continue;
        const text = block.text.trim();
        if (!text.endsWith("}"))
            continue;
        if (text.includes("```") || text.includes("`to="))
            continue;
        const marker = /\b(?:assistant\s+)?to=([a-zA-Z0-9_.-]+)\b/i.exec(text);
        if (!marker)
            continue;
        const toolName = normalizeToolName(marker[1]);
        if (!availableToolNames.has(toolName))
            continue;
        const markerIndex = marker.index ?? 0;
        const rawArguments = text.slice(markerIndex);
        const argumentsObject = parseArguments(rawArguments, toolName);
        if (Object.keys(argumentsObject).length === 0)
            continue;
        const idSeed = block.textSignature ?? `${index}`;
        return {
            type: "toolCall",
            id: buildRecoveredToolCallId(toolName, idSeed),
            name: toolName,
            arguments: argumentsObject,
        };
    }
    return null;
}
//# sourceMappingURL=tool-call-recovery.js.map