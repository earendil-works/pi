/**
 * Extracts usage statistics from a JSONL line.
 * @param jsonlLine - A complete JSON line (not a partial object)
 * @returns {input: number, output: number} if valid usage exists, undefined otherwise
 */
export function extractUsage(
  jsonlLine: string,
): { input: number; output: number } | undefined {
  const parsed = JSON.parse(jsonlLine);
  const usage = parsed?.message?.usage;

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }

  const input = usage.input;
  const output = usage.output;

  // Check if input/output are valid numbers (not strings that can't be converted)
  if (!isValidNumber(input) || !isValidNumber(output)) {
    return undefined;
  }

  // Ensure they are numbers, not strings
  const inputNum = Number(input);
  const outputNum = Number(output);

  // Must be >= 0
  if (inputNum < 0 || outputNum < 0) {
    return undefined;
  }

  return { input: inputNum, output: outputNum };
}

/**
 * Validates that a value is a valid number (not NaN, not undefined, not null, not object/array).
 */
function isValidNumber(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "object" || typeof value === "function") {
    return false;
  }
  const num = Number(value);
  return !Number.isNaN(num) && Number.isFinite(num);
}
