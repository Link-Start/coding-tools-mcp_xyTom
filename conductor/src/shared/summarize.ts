const SECRET_KEY_RE = /(token|secret|password|authorization|apikey|api_key|credential)/i;

export function summarizeArgs(value: unknown, limit = 1200): string {
  return compactJson(redact(value), limit);
}

export function summarizeResult(value: unknown, limit = 1200): string {
  return compactJson(value, limit);
}

export function compactJson(value: unknown, limit: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, jsonReplacer);
  } catch (error) {
    text = error instanceof Error ? `[unserializable: ${error.message}]` : "[unserializable]";
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 15))}...<truncated>`;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SECRET_KEY_RE.test(key) ? "[redacted]" : redact(item)]),
  );
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
