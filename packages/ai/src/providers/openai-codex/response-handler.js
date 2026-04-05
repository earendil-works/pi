/**
 * Response handling for Codex SSE streams.
 */
function toNumber(v) {
    if (v == null)
        return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}
function toInt(v) {
    if (v == null)
        return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
}
export function parseCodexRateLimits(headers) {
    const primary = {
        used_percent: toNumber(headers.get("x-codex-primary-used-percent")),
        window_minutes: toInt(headers.get("x-codex-primary-window-minutes")),
        resets_at: toInt(headers.get("x-codex-primary-reset-at")),
    };
    const secondary = {
        used_percent: toNumber(headers.get("x-codex-secondary-used-percent")),
        window_minutes: toInt(headers.get("x-codex-secondary-window-minutes")),
        resets_at: toInt(headers.get("x-codex-secondary-reset-at")),
    };
    return primary.used_percent !== undefined || secondary.used_percent !== undefined
        ? { primary, secondary }
        : undefined;
}
export async function parseCodexError(response) {
    const raw = await response.text();
    let message = raw || response.statusText || "Request failed";
    let friendlyMessage;
    const rateLimits = parseCodexRateLimits(response.headers);
    try {
        const parsed = JSON.parse(raw);
        const err = parsed?.error ?? {};
        const code = String(err.code ?? err.type ?? "");
        const resetsAt = err.resets_at ??
            rateLimits?.primary?.resets_at ??
            rateLimits?.secondary?.resets_at;
        const mins = resetsAt ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000)) : undefined;
        if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
            const planType = err.plan_type;
            const plan = planType ? ` (${String(planType).toLowerCase()} plan)` : "";
            const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
            friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
        }
        const errMessage = err.message;
        message = errMessage || friendlyMessage || message;
    }
    catch {
        // raw body not JSON
    }
    return {
        message,
        status: response.status,
        friendlyMessage,
        rateLimits,
        raw,
    };
}
/**
 * Parse SSE stream from Codex response.
 */
export async function* parseCodexSseStream(response) {
    if (!response.body) {
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = parseSseChunk(chunk);
            if (event)
                yield event;
            index = buffer.indexOf("\n\n");
        }
    }
    if (buffer.trim()) {
        const event = parseSseChunk(buffer);
        if (event)
            yield event;
    }
}
function parseSseChunk(chunk) {
    const lines = chunk.split("\n");
    const dataLines = [];
    for (const line of lines) {
        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
        }
    }
    if (dataLines.length === 0)
        return null;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]")
        return null;
    try {
        return JSON.parse(data);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=response-handler.js.map