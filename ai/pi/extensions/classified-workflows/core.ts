import path from "node:path";
import vm from "node:vm";

export type Boundary = "spawn" | "action" | "return" | "tool-result";

export type Decision =
  | { verdict: "allow"; reason: string; source: "deterministic" | "classifier" }
  | { verdict: "block"; reason: string; source: "deterministic" | "classifier" };

export interface ToolRequest {
  boundary: "action";
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}

export interface AgentRequest {
  task: string;
  cwd?: string;
  tools?: string[];
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type AgentOptions = Omit<AgentRequest, "task">;

export type AgentResult =
  | { status: "completed"; output: string; usageTokens: number }
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
  runAgent(request: AgentRequest, signal: AbortSignal): Promise<AgentResult>;
  checkpoint(message: string): Promise<"approved" | "denied">;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const TODO_ACTIONS = new Set(["list", "add", "toggle", "clear"]);
const LOCALLY_GENERATED_RESULT_TOOLS = new Set(["edit", "write", "todo"]);
const PATH_KEYS = new Set(["path", "file_path", "cwd", "glob"]);
const SENSITIVE_PATH =
  /(^|[\\/\s'"])(?:\.env(?!\.example(?:$|[\\/\s'"]))(?:\.[^\\/\s'"]*)?|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:key|pem|p12|pfx))($|[\\/\s'"])/i;
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
    return typeof input.command === "string" ? [stripNegativeGlobArguments(input.command)] : [];
  }

  return Object.entries(input).flatMap(([key, value]) =>
    PATH_KEYS.has(key) && typeof value === "string" ? [value] : [],
  );
}

function stripNegativeGlobArguments(command: string): string {
  return command.replace(
    /(?:^|\s)(?:-g|--glob)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g,
    (argument: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) =>
      (doubleQuoted ?? singleQuoted ?? bare)?.startsWith("!") ? "" : argument,
  );
}

function isInsideCwd(candidate: string, cwd: string): boolean {
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isBroadRootSearch(request: ToolRequest): boolean {
  if (request.toolName === "bash") {
    const command = request.input.command;
    if (typeof command !== "string") return false;
    const broad = /^\s*(?:rg\s+--files\b|find(?:\s+\.|\s*$)|ls(?:\s+\.|\s*$)|grep\b[^\n]*(?:\s-r\b|\s-R\b))/m.test(command);
    return broad && !hasRequiredSearchExclusions(command);
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

export function deterministicDecision(request: ToolRequest): Decision | null {
  if (relevantStrings(request.toolName, request.input).some((value) => SENSITIVE_PATH.test(value))) {
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

  if (READ_ONLY_TOOLS.has(request.toolName)) {
    return {
      verdict: "allow",
      reason: "Read-only operation outside protected paths",
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

  if (WRITE_TOOLS.has(request.toolName)) {
    const candidate = request.input.path ?? request.input.file_path;
    if (typeof candidate === "string" && isInsideCwd(candidate, request.cwd)) {
      return {
        verdict: "allow",
        reason: "Working-tree edit outside protected paths",
        source: "deterministic",
      };
    }
  }

  return null;
}

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

  let agentCount = 0;
  let usedTokens = 0;
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

  const runOnce = async (request: AgentRequest): Promise<AgentResult> => {
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
      return await Promise.race([dependencies.runAgent(request, controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      workflowController.signal.removeEventListener("abort", abortAgent);
      release();
    }
  };

  const agent = async (requestOrTask: AgentRequest | string, options?: AgentOptions): Promise<AgentResult> => {
    if (options !== undefined && !isRecord(options)) throw new Error("agent options must be an object");
    const rawRequest = typeof requestOrTask === "string" ? { ...options, task: requestOrTask } : requestOrTask;
    if (!rawRequest || typeof rawRequest.task !== "string" || rawRequest.task.trim() === "") {
      throw new Error("agent requires a non-empty task");
    }
    const request = structuredClone(rawRequest);
    if (request.task.length > 32_000) throw new Error("agent tasks may contain at most 32,000 characters");
    if (agentCount >= limits.maxAgents) throw new Error(`Workflow agent limit exceeded (${limits.maxAgents})`);
    if (usedTokens >= limits.tokenBudget) throw new Error(`Workflow token budget exceeded (${limits.tokenBudget})`);
    agentCount += 1;

    let result: AgentResult | undefined;
    for (let attempt = 0; attempt <= limits.retries; attempt += 1) {
      if (workflowController.signal.aborted) throw new Error("Workflow aborted");
      result = await runOnce(request);
      if (result.status === "completed" || result.status === "blocked") break;
    }

    if (!result) throw new Error("Agent produced no result");
    usedTokens += Math.max(0, result.usageTokens);
    if (usedTokens > limits.tokenBudget) throw new Error(`Workflow token budget exceeded (${limits.tokenBudget})`);
    return result;
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

  const context = vm.createContext(
    {
      agent,
      parallel,
      checkpoint,
      Date: undefined,
      Math: undefined,
      process: undefined,
      require: undefined,
      fetch: undefined,
      console: undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function validateLimits(limits: WorkflowLimits): void {
  const positive = [limits.maxAgents, limits.concurrency, limits.agentTimeoutMs, limits.workflowTimeoutMs, limits.tokenBudget];
  if (positive.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Workflow limits must be positive integers");
  }
  if (!Number.isInteger(limits.retries) || limits.retries < 0) throw new Error("Workflow retries must be a non-negative integer");
  if (limits.concurrency > limits.maxAgents) throw new Error("Workflow concurrency cannot exceed the agent limit");
}
