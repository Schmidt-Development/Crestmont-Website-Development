// Minimal declaration shim for @anthropic-ai/claude-agent-sdk (pinned 0.3.310 in runner/package.json).
// It mirrors ONLY the documented API the runner uses, so the runner typechecks where the package cannot be
// installed. It is not the SDK's own typing: when the package is installed, remove the "paths" entry in
// runner/tsconfig.json and typecheck against the real declarations.
//
// Sources (verified 2026-10-27):
//   https://code.claude.com/docs/en/agent-sdk/typescript            query(), Query, Options, PermissionMode, SettingSource
//   https://code.claude.com/docs/en/agent-sdk/agent-loop            result subtypes, init system message, session_id
//   https://code.claude.com/docs/en/agent-sdk/cost-tracking         total_cost_usd semantics (estimate; resumed sessions include earlier spend)
//   https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode   SDKUserMessage shape; interrupt needs streaming input
//   https://code.claude.com/docs/en/agent-sdk/skills                skills option (exact directory names)

/** https://code.claude.com/docs/en/agent-sdk/typescript#permissionmode */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/** https://code.claude.com/docs/en/agent-sdk/typescript#settingsource */
export type SettingSource = "user" | "project" | "local";

/** Streaming-input user message (streaming-vs-single-mode page). */
export interface SDKUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: string | null;
  session_id?: string;
}

/** The `init` system message carries session_id directly in TypeScript (agent-loop page, "Sessions and continuity"). */
export interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  skills?: string[];
  capabilities?: string[];
}

/** Other system subtypes (compact_boundary, informational, ...) are separate types in the SDKMessage union. */
export interface SDKOtherSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
}

export interface SDKContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

/** AssistantMessage wraps the API message in `.message` (agent-loop page, "Handle messages"). */
export interface SDKAssistantMessage {
  type: "assistant";
  message: { id: string; content: SDKContentBlock[]; usage?: { input_tokens: number; output_tokens: number } };
  parent_tool_use_id: string | null;
  session_id: string;
}

export interface SDKUserEchoMessage {
  type: "user";
  session_id?: string;
  parent_tool_use_id: string | null;
}

/**
 * Result subtypes and the fields every result carries (agent-loop page, "Handle the result"):
 * all subtypes carry total_cost_usd, usage, num_turns and session_id; `result` only on success.
 */
export type SDKResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution"
  | "error_max_structured_output_retries";

export interface SDKResultMessage {
  type: "result";
  subtype: SDKResultSubtype;
  session_id: string;
  is_error: boolean;
  num_turns: number;
  total_cost_usd: number;
  duration_ms?: number;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
  result?: string;
}

export type SDKMessage =
  | SDKSystemMessage
  | SDKOtherSystemMessage
  | SDKAssistantMessage
  | SDKUserEchoMessage
  | SDKResultMessage;

export type SystemPromptOption =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string; excludeDynamicSections?: boolean };

/** Subset of https://code.claude.com/docs/en/agent-sdk/typescript#options */
export interface Options {
  abortController?: AbortController;
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  cwd?: string;
  /** Replaces the subprocess environment (does not merge with process.env). */
  env?: Record<string, string | undefined>;
  maxTurns?: number;
  /** Counts only this call's own spend; restored totals from a resumed session don't count. */
  maxBudgetUsd?: number;
  model?: string;
  permissionMode?: PermissionMode;
  persistSession?: boolean;
  resume?: string;
  settingSources?: SettingSource[];
  systemPrompt?: SystemPromptOption;
  skills?: string[] | "all";
  stderr?: (data: string) => void;
}

/** https://code.claude.com/docs/en/agent-sdk/typescript#query-object (subset). */
export interface Query extends AsyncGenerator<SDKMessage, void> {
  /** Only available in streaming input mode. */
  interrupt(): Promise<unknown>;
  /** Forcefully ends the query and terminates the underlying process. */
  close(): void;
}

export function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
