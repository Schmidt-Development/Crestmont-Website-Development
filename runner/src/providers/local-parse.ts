// Robust extraction of tool calls from weaker local models:
//  1. native tool_calls whose `arguments` may be a JSON string, an object, fenced JSON or slightly malformed JSON;
//  2. a fallback for models that print the call as text instead of using the tool API, in the shapes seen from
//     open models: <tool_call>{"name":..,"arguments":..}</tool_call> (Qwen/Hermes style), ```json {..}``` blocks,
//     or a bare {"name":..,"arguments":..} / {"tool":..,"args":..} object.
// Only names of known tools are accepted from text, so prose that merely contains JSON is not executed.

export interface ParsedCall {
  id: string;
  name: string;
  /** Parsed arguments, or null when they could not be parsed (with `parseError`). */
  args: Record<string, unknown> | null;
  parseError: string | null;
  /** Raw argument text as the model sent it (kept for the transcript). */
  rawArgs: string;
  fromText: boolean;
}

let seq = 0;
export function newCallId(): string { seq = (seq + 1) % 1_000_000; return `call_${Date.now().toString(36)}_${seq}`; }

function stripFences(s: string): string {
  const m = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1] : s;
}

/** Parse tool arguments leniently: JSON, fenced JSON, the outermost {...}, trailing commas removed. */
export function parseArguments(raw: unknown): { args: Record<string, unknown> | null; error: string | null; text: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown>, error: null, text: JSON.stringify(raw) };
  if (raw === undefined || raw === null || raw === "") return { args: {}, error: null, text: "{}" };
  const text = String(raw);
  const candidates = [text, stripFences(text)];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of [...candidates, ...candidates.map((x) => x.replace(/,\s*([}\]])/g, "$1"))]) {
    try {
      const v = JSON.parse(c);
      // Some models double-encode: "{\"path\":\"a\"}".
      const obj = typeof v === "string" ? JSON.parse(v) : v;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return { args: obj as Record<string, unknown>, error: null, text };
    } catch { /* try next */ }
  }
  let detail = "";
  try { JSON.parse(text); } catch (e) { detail = (e as Error).message; }
  return { args: null, error: `arguments are not valid JSON (${detail || "no JSON object found"})`, text };
}

export function fromNativeCalls(calls: { id?: string; name?: string; arguments?: unknown }[]): ParsedCall[] {
  return calls.map((c) => {
    const p = parseArguments(c.arguments);
    return { id: c.id || newCallId(), name: String(c.name ?? ""), args: p.args, parseError: p.error, rawArgs: p.text.slice(0, 200_000), fromText: false };
  });
}

/** Balanced-brace JSON objects in text (strings respected). */
function jsonObjects(text: string, limit = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length && out.length < limit; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false;
        continue;
      }
      if (ch === "\"") inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; } }
    }
  }
  return out;
}

/** Tool calls printed as text. Returns [] when nothing that names a known tool is found. */
export function parseTextToolCalls(content: string | null, knownTools: string[]): ParsedCall[] {
  if (!content || !content.includes("{")) return [];
  const regions: string[] = [];
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) regions.push(m[1]);
  for (const m of content.matchAll(/```(?:json|JSON|tool_call)?\s*\n([\s\S]*?)```/g)) regions.push(m[1]);
  if (!regions.length) regions.push(content);
  const calls: ParsedCall[] = [];
  for (const region of regions) {
    for (const obj of jsonObjects(region)) {
      let v: Record<string, unknown>;
      try { v = JSON.parse(obj.replace(/,\s*([}\]])/g, "$1")) as Record<string, unknown>; } catch { continue; }
      const fn = (v.function && typeof v.function === "object" ? v.function : v) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : typeof v.tool === "string" ? v.tool : "";
      if (!knownTools.includes(name)) continue;
      const rawArgs = fn.arguments ?? fn.parameters ?? v.args ?? v.arguments ?? {};
      const p = parseArguments(rawArgs);
      calls.push({ id: newCallId(), name, args: p.args, parseError: p.error, rawArgs: p.text.slice(0, 200_000), fromText: true });
    }
  }
  return calls;
}
