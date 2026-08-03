import path from "node:path";
import vm from "node:vm";
import { availableMemoryBytes as systemAvailableMemoryBytes } from "../shared/memory-capacity.ts";

export type Boundary = "spawn" | "action" | "return" | "tool-result";

export type Decision =
  | { verdict: "allow"; reason: string; source: "deterministic" | "classifier"; resultSafe?: boolean }
  | { verdict: "block"; reason: string; source: "deterministic" | "classifier" };

export interface ToolRequest {
  boundary: "action";
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  agentArtifacts?: readonly string[];
}

export interface ToolResultRequest {
  toolName: string;
  input: Record<string, unknown>;
  content: unknown;
  cwd: string;
}

export interface AgentRequest {
  task: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  schema?: unknown;
}

export type AgentOptions = Omit<AgentRequest, "task">;

export type AgentResult =
  | {
      status: "completed";
      output: string;
      usageTokens: number;
      diagnostic?: string;
    }
  | {
      status: "blocked" | "failed" | "timed-out";
      output: "";
      reason: string;
      usageTokens: number;
    };

export interface WorkflowLimits {
  maxAgents: number;
  concurrency: number;
  agentTimeoutMs: number;
  workflowTimeoutMs: number;
  retries: number;
  tokenBudget: number;
}

export interface WorkflowDependencies {
  prepareAgentRequest?: (request: AgentRequest) => AgentRequest;
  runAgent(request: AgentRequest, signal: AbortSignal, tokenLimit: number): Promise<AgentResult>;
  checkpoint(message: string): Promise<"approved" | "denied">;
  phase?: (title: string) => void;
  log?: (message: string) => void;
  availableMemoryBytes?: () => number;
}

export const MIN_AGENT_TOKEN_RESERVATION = 4_000;
export const MIN_CLASSIFIED_AGENT_TIMEOUT_MS = 180_000;
export const MIN_WORKFLOW_FREE_MEMORY_BYTES = 8 * 1024 ** 3;
export const WORKFLOW_AGENT_MEMORY_RESERVATION_BYTES = 2 * 1024 ** 3;
const MAX_WORKFLOW_PHASES = 16;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_MAX_MS = 5_000;
const isNonRetryableBudgetFailure = (result: AgentResult): boolean =>
  result.status === "failed" && /Minimum child allocation is \d+ tokens/i.test(result.reason);

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "browser",
  "session_search",
  "memory_search",
  "workflow_audit",
]);
const TODO_ACTIONS = new Set(["list", "add", "toggle", "status", "block", "reply", "unblock", "clear"]);
const QUESTION_ACTIONS = new Set(["list", "ask", "resolve", "clear_resolved"]);
const ARTIFACT_PROVENANCE_ACTIONS = new Set(["list", "record", "forget"]);
const REVIEW_DUTY_ACTIONS = new Set([
  "status",
  "begin",
  "report",
  "recover",
  "retry-blocked",
  "retry-failed",
  "continue",
  "complete-auto",
]);
const RELEASE_CADENCE_ACTIONS = new Set(["status", "enable", "disable", "mark"]);
const isSkillView = (toolName: string, input: Readonly<Record<string, unknown>>): boolean =>
  toolName === "skill_manage" && input.action === "view";
const REGISTRY_ACTIONS = new Set([
  "list",
  "claim",
  "release",
  "delegate",
  "requests",
  "claim_request",
  "cancel_request",
  "complete_request",
  "fail_request",
]);
const PI_BRIDGE_LIST = /^pi-bridge agents$/;
const PI_BRIDGE_SEND =
  /^(?:(?:printf '%s'|echo) '[^']{1,2000}' \| )?pi-bridge send(?: --(?:agent|dedupe) [A-Za-z0-9:._-]{1,128}){1,4}$/;
const isPiBridgeRoutingCommand = (command: string): boolean => {
  const trimmed = command.trim();
  return PI_BRIDGE_LIST.test(trimmed) || PI_BRIDGE_SEND.test(trimmed);
};

export { isLocalDispatchProvider } from "../shared/local-lane.ts";

export const localDispatchLaneBlock = (toolName: string): Decision => ({
  verdict: "block",
  reason: `The local dispatch lane permits only typed routing actions without the model classifier; ${toolName} needs a full-capability agent - record the item and route it instead`,
  source: "deterministic",
});
const LOCALLY_GENERATED_RESULT_TOOLS = new Set(["edit", "write", "todo", "ask_user", "artifact_provenance", "review_duty", "release_cadence", "reload_pi", "workflow_audit", "safe_compaction_ready"]);
const PATH_KEYS = new Set(["path", "file_path", "cwd", "glob"]);
const SENSITIVE_PATH =
  /(^|[\\/\s'"])(?:\.env(?!\.example(?:$|[\\/\s'"]))(?:\.[^\\/\s'"]*)?[*?]*|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:key|pem|p12|pfx))($|[\\/\s'"])/i;
const SQL_JSONPATH_DOT_QUOTED_KEY = /\."(?:[^"\\]|\\.)*"/g;
const containsSensitivePath = (value: string): boolean =>
  SENSITIVE_PATH.test(value.replace(SQL_JSONPATH_DOT_QUOTED_KEY, "$.[json-key]"));
const SENSITIVE_RESULT =
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i;
const PROMPT_INJECTION_RESULT =
  /\bignore (?:all |any )?(?:previous|prior|above) instructions\b|\breveal (?:the )?(?:system prompt|hidden instructions)\b|\byou are now\b/i;
const REQUIRED_SEARCH_EXCLUSIONS = [
  "!.env*",
  "!credentials.json",
  "!secrets.json",
  "!secrets.yaml",
  "!*.key",
  "!*.pem",
  "!*.p12",
  "!*.pfx",
];

function relevantStrings(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === "bash") {
    return typeof input.command === "string" ? [stripNegativePathArguments(input.command)] : [];
  }

  return Object.entries(input).flatMap(([key, value]) =>
    PATH_KEYS.has(key) && typeof value === "string" ? [value] : [],
  );
}

function stripNegativePathArguments(command: string): string {
  const withoutNegativeGlobs = command.replace(
    /(?:^|\s)(?:-g|--glob)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g,
    (argument: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) =>
      (doubleQuoted ?? singleQuoted ?? bare)?.startsWith("!") ? "" : argument,
  );
  return withoutNegativeGlobs.replace(
    /(?:^|\s)(?:!|-not)\s+-(?:name|iname|path|ipath)\s+(?:"[^"]*"|'[^']*'|[^\s'"]+)/g,
    "",
  );
}

const isRecordedArtifactCleanup = (
  command: string,
  cwd: string,
  agentArtifacts: readonly string[] | undefined,
): boolean => {
  if (!agentArtifacts || agentArtifacts.length === 0 || /[;&|`$<>\n\r*?{}\[\]]/.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  if (tokens.shift() !== "rm") return false;
  let hasForce = false;
  while (tokens[0]?.startsWith("-")) {
    const option = tokens.shift();
    if (option === "--") break;
    if (!option || !/^-[rf]+$/.test(option)) return false;
    hasForce ||= option.includes("f");
  }
  if (!hasForce || tokens.length === 0 || tokens.some((operand) => operand.startsWith("-"))) return false;
  const recorded = new Set(agentArtifacts.map((candidate) => path.resolve(candidate)));
  return tokens.every((operand) => {
    const resolved = path.resolve(cwd, operand);
    return recorded.has(resolved);
  });
};

const isReadOnlyGitButlerStatusCommand = (command: string): boolean => {
  if (/[;|`$<>\n\r]/.test(command)) return false;
  const segments = command.trim().split(/\s*&&\s*/);
  if (segments.length === 0 || segments.some((segment) => !segment))
    return false;
  return segments.every((segment) => {
    const tokens = segment.trim().split(/\s+/);
    if (tokens[0] !== "but" || tokens[1] !== "status") return false;
    let expectsFormat = false;
    for (const argument of tokens.slice(2)) {
      if (expectsFormat) {
        if (!/^(?:human|agent|shell|json|none)$/.test(argument)) return false;
        expectsFormat = false;
        continue;
      }
      if (argument === "--format") {
        expectsFormat = true;
        continue;
      }
      if (
        !/^(?:-[fvruhj]|--(?:verbose|refresh-prs|upstream|no-hint|help)|--format=(?:human|agent|shell|json|none))$/.test(
          argument,
        )
      )
        return false;
    }
    return !expectsFormat;
  });
};

function isBroadRootSearch(request: ToolRequest): boolean {
  if (request.toolName === "bash") {
    const command = request.input.command;
    if (typeof command !== "string") return false;
    const sanitized = stripNegativePathArguments(command);
    const boundedTargetedFind = /(?:^|[;\n]\s*)find\s+\.\s+-maxdepth\s+[1-3]\b/.test(sanitized) &&
      [...sanitized.matchAll(/-(?:name|iname)\s+(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g)]
        .map((match) => match[1] ?? match[2] ?? match[3])
        .some((pattern) => pattern !== "*" && pattern !== "*.*");
    const broad = /^\s*(?:rg\s+--files\b|find(?:\s+\.|\s*$)|ls(?:\s+\.|\s*$)|grep\b[^\n]*(?:\s-r\b|\s-R\b))/m.test(command);
    return broad && !boundedTargetedFind && !hasRequiredSearchExclusions(command);
  }
  if (!new Set(["grep", "find", "ls"]).has(request.toolName)) return false;
  const candidate = request.input.path;
  if (candidate === undefined || candidate === "" || candidate === ".") return true;
  const resolved = path.resolve(request.cwd, String(candidate));
  return resolved === path.resolve(request.cwd) || resolved === path.parse(resolved).root;
}

function hasRequiredSearchExclusions(command: string): boolean {
  if (/(?:^|\s)#/.test(command)) return false;
  const patterns = [...command.matchAll(/(?:^|\s)(?:-g|--glob)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
  return REQUIRED_SEARCH_EXCLUSIONS.every((exclusion) => patterns.includes(exclusion));
}

const unquoteShellWord: (word: string) => string = (word) =>
  ((word.startsWith("\"") && word.endsWith("\"")) || (word.startsWith("'") && word.endsWith("'")))
    ? word.slice(1, -1)
    : word;

const isCredentialExclusionPathspec: (word: string) => boolean = (word) =>
  /^(?::[!^]|:\((?=[^)]*(?:exclude|!))[^)]*\))/.test(unquoteShellWord(word));

const isSafeCredentialExcludedGitDiff: (command: string) => boolean = (command) => {
  if (/[;&|`\n\r<>]/.test(command)) return false;
  const words = command.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g);
  if (!words || words[0] !== "git") return false;
  const diffIndex = words[1] === "-C" ? 3 : 1;
  if (
    words[diffIndex] !== "diff" ||
    (diffIndex === 3 &&
      (typeof words[2] !== "string" || !path.isAbsolute(unquoteShellWord(words[2])) || SENSITIVE_PATH.test(unquoteShellWord(words[2]))))
  ) {
    return false;
  }
  if (words.some((word) => /^--(?:output|ext-diff|textconv)(?:=|$)/.test(unquoteShellWord(word)))) return false;
  const sensitiveWords = words.filter((word) => SENSITIVE_PATH.test(unquoteShellWord(word)));
  return sensitiveWords.length > 0 && sensitiveWords.every(isCredentialExclusionPathspec);
};

const SAFE_ZELLIJ_PROBE =
  /^\s*zellij\s+(?:--version|setup\s+(?:--check|--dump-config|--dump-layout\s+[^\s;&|`]+|--dump-swap-layout\s+[^\s;&|`]+))\s*$/;

const isUnsafeZellijInvocation: (command: string) => boolean = (command) =>
  /(?:^|&&|\|\||[;|\n])\s*zellij(?:\s|$)/.test(command) && !SAFE_ZELLIJ_PROBE.test(command);

export function deterministicDecision(request: ToolRequest): Decision | null {
  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isUnsafeZellijInvocation(request.input.command)
  ) {
    return {
      verdict: "block",
      reason: "Interactive or session-mutating Zellij commands require a TTY-safe dedicated path; direct bash may emit control sequences into the user's terminal",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isSafeCredentialExcludedGitDiff(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason: "Read-only Git diff with credential-shaped paths used exclusively as exclusions",
      source: "deterministic",
    };
  }

  if (relevantStrings(request.toolName, request.input).some(containsSensitivePath)) {
    return {
      verdict: "block",
      reason: "Protected credential or secret-bearing path",
      source: "deterministic",
    };
  }

  if (isBroadRootSearch(request)) {
    return {
      verdict: "block",
      reason: "Broad searches must use an explicitly scoped path or explicit credential exclusions",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isReadOnlyGitButlerStatusCommand(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason: "Read-only GitButler status inspection",
      source: "deterministic",
    };
  }

  if (READ_ONLY_TOOLS.has(request.toolName) || isSkillView(request.toolName, request.input)) {
    return {
      verdict: "allow",
      reason: "Read-only operation outside protected paths",
      source: "deterministic",
    };
  }

  if (request.toolName === "reload_pi") {
    return {
      verdict: "allow",
      reason: "Local Pi resource reload",
      source: "deterministic",
    };
  }

  if (request.toolName === "todo" && TODO_ACTIONS.has(String(request.input.action))) {
    return {
      verdict: "allow",
      reason: "Session-local agent work tracking",
      source: "deterministic",
    };
  }

  if (request.toolName === "ask_user" && QUESTION_ACTIONS.has(String(request.input.action))) {
    return {
      verdict: "allow",
      reason: "Session-local non-blocking user question tracking",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "artifact_provenance" &&
    ARTIFACT_PROVENANCE_ACTIONS.has(String(request.input.action)) &&
    !(
      request.input.action === "record" &&
      request.input.crossWorkspace === true
    )
  ) {
    return {
      verdict: "allow",
      reason: "Session-local typed agent artifact provenance",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "review_duty" &&
    REVIEW_DUTY_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Typed local review-duty reporting gate",
      source: "deterministic",
    };
  }

  if (request.toolName === "release_cadence" && RELEASE_CADENCE_ACTIONS.has(String(request.input.action))) {
    return {
      verdict: "allow",
      reason: "Session-local verified release cadence bookkeeping",
      source: "deterministic",
    };
  }

  if (request.toolName === "agent_registry" && REGISTRY_ACTIONS.has(String(request.input.action))) {
    return {
      verdict: "allow",
      reason: "Local typed agent responsibility coordination",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isPiBridgeRoutingCommand(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason: "Exact dispatcher bridge routing command",
      source: "deterministic",
    };
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isRecordedArtifactCleanup(request.input.command, request.cwd, request.agentArtifacts)
  ) {
    return {
      verdict: "allow",
      reason: "Exact cleanup of a provenance-recorded agent artifact",
      source: "deterministic",
      resultSafe: true,
    };
  }

  return null;
}

export const shouldCarryDeterministicResultAllowance: (decision: Decision) => boolean = (decision) =>
  decision.verdict === "allow" && decision.source === "deterministic" && decision.resultSafe === true;

export const deterministicReadOnlyToolResultDecision = (request: ToolResultRequest): Decision | null => {
  const registryCoordination =
    request.toolName === "agent_registry" &&
    REGISTRY_ACTIONS.has(String(request.input.action));
  const bridgeRouting =
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isPiBridgeRoutingCommand(request.input.command);
  const gitButlerStatusRead =
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isReadOnlyGitButlerStatusCommand(request.input.command);
  if (
    !READ_ONLY_TOOLS.has(request.toolName) &&
    !registryCoordination &&
    !bridgeRouting &&
    !gitButlerStatusRead &&
    !isSkillView(request.toolName, request.input)
  ) {
    return null;
  }
  const action = deterministicDecision({
    boundary: "action",
    toolName: request.toolName,
    input: request.input,
    cwd: request.cwd,
  });
  if (action?.verdict !== "allow") return null;
  const serialized = typeof request.content === "string" ? request.content : (JSON.stringify(request.content) ?? "");
  if (SENSITIVE_RESULT.test(serialized) || PROMPT_INJECTION_RESULT.test(serialized)) return null;
  return {
    verdict: "allow",
    reason: "Bounded read-only result passed local sensitive-content guards",
    source: "deterministic",
  };
};

export function deterministicToolResultDecision(toolName: string): Decision | null {
  return LOCALLY_GENERATED_RESULT_TOOLS.has(toolName)
    ? {
        verdict: "allow",
        reason: "Locally generated mutation acknowledgement",
        source: "deterministic",
      }
    : null;
}

export function parseClassifierDecision(text: string): Decision {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (isRecord(parsed)) {
      const { verdict, reason } = parsed;
      if ((verdict === "allow" || verdict === "block") && typeof reason === "string") {
        return { verdict, reason, source: "classifier" };
      }
    }
  } catch {
    // Fail closed below.
  }
  return {
    verdict: "block",
    reason: "Classifier returned an invalid decision",
    source: "classifier",
  };
}

const validateStructuredValue = (value: unknown, schema: unknown, path = "$" ): void => {
  if (!isRecord(schema)) throw new Error("agent schema must be a JSON Schema object");
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`structured agent output violates enum at ${path}`);
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new Error(`structured agent output requires an object at ${path}`);
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key !== "string" || !(key in value)) throw new Error(`structured agent output is missing ${path}.${String(key)}`);
    }
    if (isRecord(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (key in value) validateStructuredValue(value[key], child, `${path}.${key}`);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`structured agent output requires an array at ${path}`);
    if (schema.items !== undefined) value.forEach((item, index) => validateStructuredValue(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (schema.type === "string" && typeof value !== "string") throw new Error(`structured agent output requires a string at ${path}`);
  if (schema.type === "integer" && !Number.isInteger(value)) throw new Error(`structured agent output requires an integer at ${path}`);
  if (schema.type === "number" && typeof value !== "number") throw new Error(`structured agent output requires a number at ${path}`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`structured agent output requires a boolean at ${path}`);
};

const parseStructuredAgentOutput = (output: string, schema: unknown): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("structured agent output was not valid JSON");
  }
  validateStructuredValue(parsed, schema);
  return parsed;
};

const structuredRepairRequest = (
  request: AgentRequest,
  reason: string,
): AgentRequest => {
  const instruction =
    `Your prior structured output failed validation: ${reason.slice(0, 240)}. ` +
    "Return one replacement JSON value that strictly satisfies the same schema. Do not add prose or markdown.\n\n";
  return {
    ...request,
    task: `${instruction}${request.task.slice(0, Math.max(0, 32_000 - instruction.length))}`,
  };
};

export async function runWorkflowScript(
  code: string,
  limits: WorkflowLimits,
  dependencies: WorkflowDependencies,
  signal?: AbortSignal,
): Promise<unknown> {
  validateLimits(limits);
  const workflowController = new AbortController();
  const abortWorkflow = () => workflowController.abort(signal?.reason);
  if (signal?.aborted) abortWorkflow();
  else signal?.addEventListener("abort", abortWorkflow, { once: true });

  let phaseAgentCount = 0;
  let phaseCount = 0;
  let inFlightAgentCalls = 0;
  let usedTokens = 0;
  let reservedTokens = 0;
  const perAgentTokenLimit = Math.floor(limits.tokenBudget / limits.maxAgents);
  let activeAgents = 0;
  const waiters: Array<() => void> = [];

  const acquire = async () => {
    if (activeAgents < limits.concurrency) {
      activeAgents += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    activeAgents += 1;
  };

  const release = () => {
    activeAgents -= 1;
    waiters.shift()?.();
  };

  const runOnce = async (request: AgentRequest, tokenLimit: number): Promise<AgentResult> => {
    await acquire();
    const controller = new AbortController();
    const abortAgent = () => controller.abort(workflowController.signal.reason);
    workflowController.signal.addEventListener("abort", abortAgent, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Agent timed out")), limits.agentTimeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => reject(controller.signal.reason ?? new Error("Agent aborted"));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      return await Promise.race([dependencies.runAgent(request, controller.signal, tokenLimit), aborted]);
    } finally {
      clearTimeout(timer);
      workflowController.signal.removeEventListener("abort", abortAgent);
      release();
    }
  };

  const agent = async (requestOrTask: AgentRequest | string, options?: AgentOptions): Promise<unknown> => {
    if (options !== undefined && !isRecord(options)) throw new Error("agent options must be an object");
    const rawRequest = typeof requestOrTask === "string" ? { ...options, task: requestOrTask } : requestOrTask;
    if (!rawRequest || typeof rawRequest.task !== "string" || rawRequest.task.trim() === "") {
      throw new Error("agent requires a non-empty task");
    }
    const clonedRequest = structuredClone(rawRequest);
    const request = dependencies.prepareAgentRequest?.(clonedRequest) ?? clonedRequest;
    if (request.task.length > 32_000) throw new Error("agent tasks may contain at most 32,000 characters");
    if (request.schema !== undefined) {
      if (!isRecord(request.schema)) throw new Error("agent schema must be a JSON Schema object");
      let encodedSchema: string;
      try {
        encodedSchema = JSON.stringify(request.schema);
      } catch {
        throw new Error("agent schema must be JSON serializable");
      }
      if (encodedSchema.length > 16_000) throw new Error("agent schema may contain at most 16,000 characters");
    }
    if (phaseAgentCount >= limits.maxAgents) {
      throw new Error(
        `Workflow phase agent limit exceeded (${limits.maxAgents}); start a new named phase only after current children settle`,
      );
    }
    const availableMemory = dependencies.availableMemoryBytes?.() ?? Number(systemAvailableMemoryBytes());
    const requiredMemory = MIN_WORKFLOW_FREE_MEMORY_BYTES + activeAgents * WORKFLOW_AGENT_MEMORY_RESERVATION_BYTES;
    if (!Number.isFinite(availableMemory) || availableMemory < requiredMemory) {
      const availableGiB = Number.isFinite(availableMemory) ? (availableMemory / 1024 ** 3).toFixed(1) : "unknown";
      const requiredGiB = (requiredMemory / 1024 ** 3).toFixed(1);
      throw new Error(
        `Workflow memory reserve cannot start another agent: ${availableGiB} GiB available; ${requiredGiB} GiB required for the crash reserve and ${activeAgents} active agent(s)`,
      );
    }
    const availableTokens = limits.tokenBudget - usedTokens - reservedTokens;
    const agentTokenLimit = Math.min(perAgentTokenLimit, availableTokens);
    if (agentTokenLimit < MIN_AGENT_TOKEN_RESERVATION) {
      throw new Error(
        `Workflow token budget cannot start another agent: ${Math.max(0, availableTokens)} tokens remain; minimum child reservation is ${MIN_AGENT_TOKEN_RESERVATION}`,
      );
    }
    phaseAgentCount += 1;
    inFlightAgentCalls += 1;
    reservedTokens += agentTokenLimit;

    let result: AgentResult | undefined;
    let agentUsageTokens = 0;
    try {
      for (let attempt = 0; attempt <= limits.retries; attempt += 1) {
        if (workflowController.signal.aborted) throw new Error("Workflow aborted");
        try {
          const remainingAgentTokens = Math.max(0, agentTokenLimit - agentUsageTokens);
          if (remainingAgentTokens < MIN_AGENT_TOKEN_RESERVATION) {
            result = {
              status: "failed",
              output: "",
              reason: `Agent token budget exhausted (${agentUsageTokens}/${agentTokenLimit})`,
              usageTokens: 0,
            };
            break;
          }
          result = await runOnce(request, remainingAgentTokens);
          agentUsageTokens += Math.max(0, result.usageTokens);
          if (
            result.status === "completed" ||
            result.status === "blocked" ||
            isNonRetryableBudgetFailure(result)
          ) break;
          if (attempt < limits.retries) {
            await retryBackoff(attempt, workflowController.signal);
          }
        } catch (error) {
          if (workflowController.signal.aborted) throw error;
          if (attempt >= limits.retries) {
            const reason = error instanceof Error ? error.message : "Agent failed";
            result = {
              status: /timed out/i.test(reason) ? "timed-out" : "failed",
              output: "",
              reason,
              usageTokens: 0,
            };
            break;
          }
          await retryBackoff(attempt, workflowController.signal);
        }
      }
    } finally {
      reservedTokens -= agentTokenLimit;
      inFlightAgentCalls -= 1;
    }

    if (!result) throw new Error("Agent produced no result");
    usedTokens += agentUsageTokens;
    const measuredResult: AgentResult = agentUsageTokens > agentTokenLimit
      ? {
          status: "failed",
          output: "",
          reason: `Agent exceeded token limit (${agentUsageTokens}/${agentTokenLimit})`,
          usageTokens: agentUsageTokens,
        }
      : { ...result, usageTokens: agentUsageTokens };
    if (request.schema === undefined) return measuredResult;
    if (measuredResult.status !== "completed") {
      throw new Error(`structured agent ${measuredResult.status}: ${measuredResult.reason ?? "no result"}`);
    }
    try {
      return parseStructuredAgentOutput(measuredResult.output, request.schema);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "structured agent output failed validation";
      const remainingTokens = Math.max(0, agentTokenLimit - agentUsageTokens);
      if (remainingTokens < MIN_AGENT_TOKEN_RESERVATION) throw error;
      const repair = await runOnce(
        structuredRepairRequest(request, reason),
        remainingTokens,
      );
      agentUsageTokens += Math.max(0, repair.usageTokens);
      usedTokens += Math.max(0, repair.usageTokens);
      if (agentUsageTokens > agentTokenLimit) {
        throw new Error(
          `structured agent repair exceeded token limit (${agentUsageTokens}/${agentTokenLimit})`,
        );
      }
      if (repair.status !== "completed") {
        throw new Error(
          `structured agent repair ${repair.status}: ${repair.reason ?? "no result"}`,
        );
      }
      try {
        return parseStructuredAgentOutput(repair.output, request.schema);
      } catch (repairError) {
        const repairReason =
          repairError instanceof Error
            ? repairError.message
            : "structured agent output failed validation";
        throw new Error(
          `structured agent output remained invalid after one bounded repair: ${repairReason}`,
        );
      }
    }
  };

  const parallel = async <T>(tasks: Array<PromiseLike<T> | (() => PromiseLike<T>)>): Promise<T[]> => {
    if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== "function" && !isPromiseLike(task))) {
      throw new Error("parallel requires an array of promises or functions");
    }
    return Promise.all(tasks.map((task) => (typeof task === "function" ? task() : task)));
  };

  const checkpoint = async (message: string): Promise<void> => {
    if (typeof message !== "string" || message.trim() === "") throw new Error("checkpoint requires a message");
    if ((await dependencies.checkpoint(message)) !== "approved") throw new Error(`Checkpoint denied: ${message}`);
  };

  const phase = (title: string): void => {
    if (typeof title !== "string" || title.trim() === "" || title.length > 80) {
      throw new Error("phase requires a non-empty title of at most 80 characters");
    }
    if (inFlightAgentCalls > 0) {
      throw new Error(
        `Workflow cannot change phase while ${inFlightAgentCalls} agent call(s) are still active`,
      );
    }
    if (phaseCount >= MAX_WORKFLOW_PHASES) {
      throw new Error(`Workflow may use at most ${MAX_WORKFLOW_PHASES} named phases`);
    }
    phaseCount += 1;
    phaseAgentCount = 0;
    dependencies.phase?.(title);
  };

  const log = (message: string): void => {
    if (typeof message !== "string" || message.trim() === "" || message.length > 2_000) {
      throw new Error("log requires a non-empty message of at most 2,000 characters");
    }
    dependencies.log?.(message);
  };

  const context = vm.createContext(
    {
      agent,
      parallel,
      checkpoint,
      phase,
      log,
      Date: undefined,
      process: undefined,
      require: undefined,
      fetch: undefined,
      console: undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const deterministicMath = new vm.Script(
    `Object.defineProperty(Math, "random", {
       value: undefined,
       writable: false,
       configurable: false
     });
     Object.freeze(Math);`,
  );
  deterministicMath.runInContext(context, { timeout: 100 });
  const script = new vm.Script(`(async () => { "use strict"; ${code}\n})()`);
  const workflow: Promise<unknown> = script.runInContext(context, { timeout: 1_000 });
  const timer = setTimeout(() => workflowController.abort(new Error("Workflow timed out")), limits.workflowTimeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(workflowController.signal.reason ?? new Error("Workflow aborted"));
    if (workflowController.signal.aborted) rejectAbort();
    else workflowController.signal.addEventListener("abort", rejectAbort, { once: true });
  });

  try {
    const result = await Promise.race([workflow, aborted]);
    return result === undefined ? undefined : structuredClone(result);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortWorkflow);
  }
}

const retryBackoff: (attempt: number, signal: AbortSignal) => Promise<void> = async (attempt, signal) => {
  const delayMs = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_MAX_MS);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Workflow aborted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

export const minimumRetryEnvelopeMs: (agentTimeoutMs: number, retries: number) => number = (
  agentTimeoutMs,
  retries,
) =>
  agentTimeoutMs * (retries + 1) +
  Array.from({ length: retries }, (_unused, attempt) =>
    Math.min(RETRY_BACKOFF_BASE_MS * 2 ** attempt, RETRY_BACKOFF_MAX_MS),
  ).reduce((total, delayMs) => total + delayMs, 0);

function validateLimits(limits: WorkflowLimits): void {
  const positive = [limits.maxAgents, limits.concurrency, limits.agentTimeoutMs, limits.workflowTimeoutMs, limits.tokenBudget];
  if (positive.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Workflow limits must be positive integers");
  }
  if (!Number.isInteger(limits.retries) || limits.retries < 0) throw new Error("Workflow retries must be a non-negative integer");
  if (limits.concurrency > limits.maxAgents) throw new Error("Workflow concurrency cannot exceed the agent limit");
  const perAgentTokenLimit = Math.floor(limits.tokenBudget / limits.maxAgents);
  if (perAgentTokenLimit < MIN_AGENT_TOKEN_RESERVATION) {
    throw new Error(
      `Workflow token budget minimum reservation is ${MIN_AGENT_TOKEN_RESERVATION} tokens per configured agent; ${perAgentTokenLimit} available`,
    );
  }
  const retryEnvelopeMs = minimumRetryEnvelopeMs(limits.agentTimeoutMs, limits.retries);
  if (limits.workflowTimeoutMs < retryEnvelopeMs) {
    throw new Error(
      `Workflow timeout ${limits.workflowTimeoutMs}ms cannot fit one agent's retry envelope of ${retryEnvelopeMs}ms`,
    );
  }
}
