import path from "node:path"
import { parseLoopCommandResult } from "./loop.ts"
import { maskLiteralNonPathArguments } from "./non-path-arguments.ts"

export type Boundary = "spawn" | "action" | "return" | "tool-result"

export type Decision =
  | {
      verdict: "allow"
      reason: string
      source: "deterministic" | "classifier"
      resultSafe?: boolean
    }
  | {
      verdict: "remediate"
      reason: string
      source: "classifier"
    }
  | { verdict: "block"; reason: string; source: "deterministic" | "classifier" }

export interface ToolRequest {
  boundary: "action"
  toolName: string
  input: Record<string, unknown>
  cwd: string
  agentArtifacts?: readonly string[]
}

export interface ToolResultRequest {
  toolName: string
  input: Record<string, unknown>
  content: unknown
  cwd: string
}

export {
  WorkflowScriptError,
  normalizeAgentTools,
  minimumRetryEnvelopeMs,
  runWorkflowScript,
  MIN_AGENT_TOKEN_RESERVATION,
  MIN_CLASSIFIED_AGENT_TIMEOUT_MS,
  MIN_WORKFLOW_FREE_MEMORY_BYTES,
  WORKFLOW_AGENT_MEMORY_RESERVATION_BYTES,
  type AgentRequest,
  type AgentOptions,
  type AgentResult,
  type AgentUsageObserver,
  type WorkflowDependencies,
  type WorkflowLimits,
} from "./workflow-engine.ts"

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "browser",
  "session_search",
  "memory_search",
  "workflow_audit",
])
const TODO_ACTIONS = new Set([
  "list",
  "add",
  "toggle",
  "status",
  "block",
  "reply",
  "unblock",
  "clear",
])
const LOCAL_QUESTION_ACTIONS = new Set([
  "list",
  "resolve",
  "reopen",
  "clear_resolved",
])
const ARTIFACT_PROVENANCE_ACTIONS = new Set([
  "list",
  "record",
  "create_directory",
  "forget",
])
const REVIEW_DUTY_ACTIONS = new Set([
  "status",
  "begin",
  "report",
  "recover",
  "recover-evidence",
  "retry-blocked",
  "retry-failed",
  "continue",
  "complete-auto",
])
const RELEASE_CADENCE_ACTIONS = new Set(["status", "enable", "disable", "mark"])
const isSkillView = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): boolean => toolName === "skill_manage" && input.action === "view"
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
])
const PI_BRIDGE_LIST = /^pi-bridge agents$/
const PI_BRIDGE_SEND =
  /^(?:(?:printf '%s'|echo) '[^']{1,2000}' \| )?pi-bridge send(?: --(?:agent|dedupe|requester) [A-Za-z0-9:._-]{1,128}){1,6}$/
const PI_BRIDGE_OWNER_REPORT =
  /^(?:printf '%s'|echo) '[^']{1,16000}' \| pi-bridge owner-report --sender [A-Za-z0-9:._-]{1,128}$/
const isPiBridgeRoutingCommand = (command: string): boolean => {
  const trimmed = command.trim()
  const bridgeSend =
    PI_BRIDGE_SEND.test(trimmed) &&
    !/--requester (?:telegram-owner-|owner-pane(?: |$))/u.test(trimmed)
  return (
    PI_BRIDGE_LIST.test(trimmed) ||
    bridgeSend ||
    PI_BRIDGE_OWNER_REPORT.test(trimmed)
  )
}

export { isLocalDispatchProvider } from "../shared/local-lane.ts"

export const localDispatchLaneBlock = (toolName: string): Decision => ({
  verdict: "block",
  reason: `The local dispatch lane permits only typed routing actions without the model classifier; ${toolName} needs a full-capability agent - record the item and route it instead`,
  source: "deterministic",
})
const LOCALLY_GENERATED_RESULT_TOOLS = new Set([
  "edit",
  "write",
  "todo",
  "ask_user",
  "artifact_provenance",
  "review_duty",
  "release_cadence",
  "reload_pi",
  "loop_control",
  "workflow_audit",
  "safe_compaction_ready",
])
const PATH_KEYS = new Set(["path", "file_path", "cwd", "glob"])
const SENSITIVE_PATH =
  /(^|[\\/\s'"])(?:\.env(?!\.example(?:$|[\\/\s'"]))(?:\.[^\\/\s'"]*)?[*?]*|credentials\.json|secrets\.(?:json|ya?ml)|auth\.json|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\\/\s'"]+\.(?:age|key|pem|p12|pfx))($|[\\/\s'"])/i
const SQL_JSONPATH_DOT_QUOTED_KEY = /\."(?:[^"\\]|\\.)*"/g
const containsSensitivePath = (value: string): boolean =>
  SENSITIVE_PATH.test(
    value
      .replace(SQL_JSONPATH_DOT_QUOTED_KEY, "$.[json-key]")
      .replace(/[=;&|<>(){}\[\]]/g, " "),
  )
const SENSITIVE_RESULT =
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i
const PROMPT_INJECTION_RESULT =
  /\bignore (?:all |any )?(?:previous|prior|above) instructions\b|\breveal (?:the )?(?:system prompt|hidden instructions)\b|\byou are now\b/i
export const REQUIRED_SEARCH_EXCLUSIONS = [
  "!.env*",
  "!credentials.json",
  "!secrets.json",
  "!secrets.yaml",
  "!*.age",
  "!*.key",
  "!*.pem",
  "!*.p12",
  "!*.pfx",
] as const

const NUSHELL_RECORD_SELECTOR =
  /\$[A-Za-z_][A-Za-z0-9_-]*(?:\??\.[A-Za-z_][A-Za-z0-9_-]*\??)+/g

const stripNushellRecordSelectors = (command: string): string =>
  command.replace(NUSHELL_RECORD_SELECTOR, () => "$record-selector")

function relevantStrings(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "bash") {
    return typeof input.command === "string"
      ? [
          stripNushellRecordSelectors(
            stripNegativePathArguments(
              maskLiteralNonPathArguments(input.command),
            ),
          ),
        ]
      : []
  }

  return Object.entries(input).flatMap(([key, value]) =>
    PATH_KEYS.has(key) && typeof value === "string" ? [value] : [],
  )
}

function stripNegativePathArguments(command: string): string {
  const withoutNegativeGlobs = command.replace(
    /(?:^|\s)(?:-g|--glob)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g,
    (
      argument: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      bare: string | undefined,
    ) =>
      (doubleQuoted ?? singleQuoted ?? bare)?.startsWith("!") ? "" : argument,
  )
  return withoutNegativeGlobs.replace(
    /(?:^|\s)(?:!|-not)\s+-(?:name|iname|path|ipath)\s+(?:"[^"]*"|'[^']*'|[^\s'"]+)/g,
    "",
  )
}

const isRecordedArtifactCleanup = (
  command: string,
  cwd: string,
  agentArtifacts: readonly string[] | undefined,
): boolean => {
  if (
    !agentArtifacts ||
    agentArtifacts.length === 0 ||
    /[;&|`$<>\n\r*?{}\[\]]/.test(command)
  )
    return false
  const tokens = command.trim().split(/\s+/)
  if (tokens.shift() !== "rm") return false
  let hasForce = false
  while (tokens[0]?.startsWith("-")) {
    const option = tokens.shift()
    if (option === "--") break
    if (!option || !/^-[rf]+$/.test(option)) return false
    hasForce ||= option.includes("f")
  }
  if (
    !hasForce ||
    tokens.length === 0 ||
    tokens.some(operand => operand.startsWith("-"))
  )
    return false
  const recorded = new Set(
    agentArtifacts.map(candidate => path.resolve(candidate)),
  )
  return tokens.every(operand => {
    const resolved = path.resolve(cwd, operand)
    return recorded.has(resolved)
  })
}

const isReadOnlyGitButlerStatusCommand = (command: string): boolean => {
  if (/[;|`$<>\n\r]/.test(command)) return false
  const segments = command.trim().split(/\s*&&\s*/)
  if (segments.length === 0 || segments.some(segment => !segment)) return false
  return segments.every(segment => {
    const tokens = segment.trim().split(/\s+/)
    if (tokens[0] !== "but" || tokens[1] !== "status") return false
    let expectsFormat = false
    for (const argument of tokens.slice(2)) {
      if (expectsFormat) {
        if (!/^(?:human|agent|shell|json|none)$/.test(argument)) return false
        expectsFormat = false
        continue
      }
      if (argument === "--format") {
        expectsFormat = true
        continue
      }
      if (
        !/^(?:-[fvruhj]+|--(?:verbose|refresh-prs|json|upstream|no-hint|status-after|help)|--format=(?:human|agent|shell|json|none))$/.test(
          argument,
        )
      )
        return false
    }
    return !expectsFormat
  })
}

function isBroadRootSearch(request: ToolRequest): boolean {
  if (request.toolName === "bash") {
    const command = request.input.command
    if (typeof command !== "string") return false
    const listingPath =
      /^ls[ \t]+(\.[A-Za-z0-9_./-]+)(?:[ \t]+\|[ \t]+select[ \t]+name[ \t]+size)?$/.exec(
        command.trim(),
      )?.[1]
    if (listingPath && !listingPath.split("/").includes("..")) {
      const root = path.resolve(request.cwd)
      const target = path.resolve(root, listingPath)
      if (target.startsWith(`${root}${path.sep}`)) return false
    }
    const sanitized = stripNegativePathArguments(command)
    const boundedTargetedFind =
      /(?:^|[;\n]\s*)find\s+\.\s+-maxdepth\s+[1-3]\b/.test(sanitized) &&
      [
        ...sanitized.matchAll(
          /-(?:name|iname)\s+(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g,
        ),
      ]
        .map(match => match[1] ?? match[2] ?? match[3])
        .some(pattern => pattern !== "*" && pattern !== "*.*")
    const broad =
      /^\s*(?:rg\s+--files\b|find(?:\s+\.|\s*$)|ls(?:\s+\.|\s*$)|grep\b[^\n]*(?:\s-r\b|\s-R\b))/m.test(
        command,
      )
    return (
      broad && !boundedTargetedFind && !hasRequiredSearchExclusions(command)
    )
  }
  if (!new Set(["grep", "find", "ls"]).has(request.toolName)) return false
  const candidate = request.input.path
  if (candidate === undefined || candidate === "" || candidate === ".")
    return true
  const resolved = path.resolve(request.cwd, String(candidate))
  return (
    resolved === path.resolve(request.cwd) ||
    resolved === path.parse(resolved).root
  )
}

function hasRequiredSearchExclusions(command: string): boolean {
  if (/(?:^|\s)#/.test(command)) return false
  const patterns = [
    ...command.matchAll(
      /(?:^|\s)(?:-g|--glob)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/g,
    ),
  ].map(match => match[1] ?? match[2] ?? match[3])
  return REQUIRED_SEARCH_EXCLUSIONS.every(exclusion =>
    patterns.includes(exclusion),
  )
}

const unquoteShellWord: (word: string) => string = word =>
  (word.startsWith('"') && word.endsWith('"')) ||
  (word.startsWith("'") && word.endsWith("'"))
    ? word.slice(1, -1)
    : word

const isCredentialExclusionPathspec: (word: string) => boolean = word =>
  /^(?::[!^]|:\((?=[^)]*(?:exclude|!))[^)]*\))/.test(unquoteShellWord(word))

const isSafeCredentialExcludedGitDiffSegment: (
  command: string,
) => boolean = command => {
  const words = command.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)
  if (!words || words[0] !== "git") return false
  const diffIndex = words[1] === "-C" ? 3 : 1
  if (
    words[diffIndex] !== "diff" ||
    (diffIndex === 3 &&
      (typeof words[2] !== "string" ||
        !path.isAbsolute(unquoteShellWord(words[2])) ||
        SENSITIVE_PATH.test(unquoteShellWord(words[2]))))
  ) {
    return false
  }
  if (
    words.some(word =>
      /^--(?:output|ext-diff|textconv)(?:=|$)/.test(unquoteShellWord(word)),
    )
  )
    return false
  const sensitiveWords = words.filter(word =>
    SENSITIVE_PATH.test(unquoteShellWord(word)),
  )
  return (
    sensitiveWords.length > 0 &&
    sensitiveWords.every(isCredentialExclusionPathspec)
  )
}

const isSafeBoundedGitWorkingTreeRead = (command: string): boolean => {
  if (/[;|`\n\r<>]/u.test(command)) return false
  const words = command.trim().match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/gu)
  if (!words || words[0] !== "git") return false
  const args = words.slice(1).map(unquoteShellWord)
  if (args[0] === "status")
    return args
      .slice(1)
      .every(
        arg =>
          arg === "--short" ||
          arg === "--porcelain" ||
          arg === "--branch" ||
          arg === "--untracked-files=no" ||
          arg === "--" ||
          (!arg.startsWith("-") && !containsSensitivePath(arg)),
      )
  if (args[0] === "diff" && args[1] === "--name-only")
    return args
      .slice(2)
      .every(
        arg =>
          arg === "--" || (!arg.startsWith("-") && !containsSensitivePath(arg)),
      )
  return false
}

const isSafeGitObjectTypeCheck: (command: string) => boolean = command =>
  /^git\s+cat-file\s+-t\s+[0-9a-f]{7,64}$/i.test(command.trim())

const isSafeCredentialExcludedGitDiff: (
  command: string,
) => boolean = command => {
  if (/[;|`\n\r<>]/.test(command)) return false
  const segments = command.trim().split(/\s*&&\s*/)
  if (
    segments.some(segment => segment === "") ||
    command.replace(/\s*&&\s*/g, "").includes("&")
  )
    return false
  if (segments.length === 1)
    return segments[0]
      ? isSafeCredentialExcludedGitDiffSegment(segments[0])
      : false
  return (
    segments.length === 2 &&
    typeof segments[0] === "string" &&
    typeof segments[1] === "string" &&
    isSafeGitObjectTypeCheck(segments[0]) &&
    isSafeCredentialExcludedGitDiffSegment(segments[1])
  )
}

const isSafeFixedExactHeadGitShowRange: (
  command: string,
) => boolean = command => {
  const match = command.match(
    /^\s*git\s+show\s+'([0-9a-f]{7,64}):([A-Za-z0-9._/-]+)'\s*\|\s*sed\s+-n\s+'([1-9]\d{0,6})(?:,([1-9]\d{0,6}))?p'\s*$/i,
  )
  if (!match) return false
  const sourcePath = match[2]
  const startText = match[3]
  if (!sourcePath || !startText) return false
  const segments = sourcePath.split("/")
  if (
    segments.some(
      segment => segment === "" || segment === "." || segment === "..",
    )
  )
    return false
  if (containsSensitivePath(sourcePath)) return false
  const start = Number(startText)
  const end = Number(match[4] ?? startText)
  return end >= start && end - start + 1 <= 2_000
}

const SAFE_ZELLIJ_PROBE =
  /^\s*zellij\s+(?:--version|setup\s+(?:--check|--dump-config|--dump-layout\s+[^\s;&|`]+|--dump-swap-layout\s+[^\s;&|`]+))\s*$/

const isUnsafeZellijInvocation: (command: string) => boolean = command =>
  /(?:^|&&|\|\||[;|\n])\s*zellij(?:\s|$)/.test(command) &&
  !SAFE_ZELLIJ_PROBE.test(command)

const maskQuotedCommandContent = (command: string): string | null => {
  let masked = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (quote) {
      if (character === quote) {
        if (command[index + 1] === quote) {
          index += 1
          continue
        }
        quote = undefined
        masked += "Q"
      } else if (quote === '"' && character === "\\") {
        index += 1
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    masked += character
  }
  return quote ? null : masked
}

const isExactAgentopolyCapabilityMarketPrMetadata = (
  cwd: string,
  command: string,
): boolean => {
  if (
    path.resolve(cwd) !==
    "/Users/0xgleb/code/0xgleb/agentopoly/.worktrees/tertiary"
  ) {
    return false
  }
  const masked = maskQuotedCommandContent(command)?.trim()
  if (!masked) return false
  return (
    /^\^?gh\s+pr\s+create\s+--base\s+main\s+--head\s+feat\/capability-market\s+--title\s+Q\s+--body\s+\$Q$/.test(
      masked,
    ) ||
    /^let\s+body\s*=\s*\$Q\s+\^?gh\s+pr\s+edit\s+32\s+--repo\s+0xgleb\/agentopoly\s+--body\s+\$body$/.test(
      masked,
    )
  )
}

export function deterministicDecision(request: ToolRequest): Decision | null {
  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isUnsafeZellijInvocation(request.input.command)
  ) {
    return {
      verdict: "block",
      reason:
        "Interactive or session-mutating Zellij commands require a TTY-safe dedicated path; direct bash may emit control sequences into the user's terminal",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isSafeCredentialExcludedGitDiff(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason:
        "Read-only Git diff with credential-shaped paths used exclusively as exclusions",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isSafeFixedExactHeadGitShowRange(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason: "Fixed exact-head Git source range inspection",
      source: "deterministic",
    }
  }

  if (
    relevantStrings(request.toolName, request.input).some(containsSensitivePath)
  ) {
    return {
      verdict: "block",
      reason: "Protected credential or secret-bearing path",
      source: "deterministic",
    }
  }

  if (isBroadRootSearch(request)) {
    return {
      verdict: "block",
      reason:
        "Broad searches must use an explicitly scoped non-sensitive file/path. Native grep/find/ls at the cwd root cannot express credential exclusions; use an exact path or bash rg with " +
        REQUIRED_SEARCH_EXCLUSIONS.map(glob => `-g '${glob}'`).join(" "),
      source: "deterministic",
    }
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isExactAgentopolyCapabilityMarketPrMetadata(
      request.cwd,
      request.input.command,
    )
  ) {
    return {
      verdict: "allow",
      reason:
        "Exact owner-authorized Agentopoly capability-market PR publication metadata",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isSafeBoundedGitWorkingTreeRead(request.input.command)
  ) {
    return {
      verdict: "allow",
      reason: "Bounded read-only Git working-tree inspection",
      source: "deterministic",
      resultSafe: true,
    }
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
    }
  }

  if (
    READ_ONLY_TOOLS.has(request.toolName) ||
    isSkillView(request.toolName, request.input)
  ) {
    return {
      verdict: "allow",
      reason: "Read-only operation outside protected paths",
      source: "deterministic",
    }
  }

  if (request.toolName === "reload_pi") {
    return {
      verdict: "allow",
      reason: "Local Pi resource reload",
      source: "deterministic",
    }
  }

  if (request.toolName === "safe_compaction_ready") {
    return {
      verdict: "allow",
      reason: "Typed safe-compaction state acknowledgement",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "loop_control" &&
    typeof request.input.args === "string"
  ) {
    const parsed = parseLoopCommandResult(request.input.args)
    if (!parsed.ok)
      return {
        verdict: "block",
        reason: parsed.error.message,
        source: "deterministic",
      }
    return {
      verdict: "allow",
      reason: "Session-local recurring loop control",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "todo" &&
    TODO_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Session-local agent work tracking",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "ask_user" &&
    LOCAL_QUESTION_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Session-local non-blocking user question tracking",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "artifact_provenance" &&
    ARTIFACT_PROVENANCE_ACTIONS.has(String(request.input.action)) &&
    !(
      (request.input.action === "record" ||
        request.input.action === "create_directory") &&
      request.input.crossWorkspace === true
    )
  ) {
    return {
      verdict: "allow",
      reason: "Session-local typed agent artifact provenance",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "review_duty" &&
    REVIEW_DUTY_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Typed local review-duty reporting gate",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "release_cadence" &&
    RELEASE_CADENCE_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Session-local verified release cadence bookkeeping",
      source: "deterministic",
    }
  }

  if (
    request.toolName === "agent_registry" &&
    REGISTRY_ACTIONS.has(String(request.input.action))
  ) {
    return {
      verdict: "allow",
      reason: "Local typed agent responsibility coordination",
      source: "deterministic",
    }
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
    }
  }

  if (
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isRecordedArtifactCleanup(
      request.input.command,
      request.cwd,
      request.agentArtifacts,
    )
  ) {
    return {
      verdict: "allow",
      reason: "Exact cleanup of a provenance-recorded agent artifact",
      source: "deterministic",
      resultSafe: true,
    }
  }

  return null
}

export const shouldCarryDeterministicResultAllowance: (
  decision: Decision,
) => boolean = decision =>
  decision.verdict === "allow" &&
  decision.source === "deterministic" &&
  decision.resultSafe === true

const SCOPE_RELITIGATION_REASON =
  /\b(?:unrelated|stale|outside (?:the )?(?:active )?scope|not (?:currently )?(?:authorized|within scope)|no (?:explicit )?authority|active (?:task|todo)|current (?:task|todo)|task scope)\b/i
const EVIDENCE_RELITIGATION_REASON =
  /\b(?:verif(?:y|ied) independently|independent verification)\b/i
const RESULT_SAFETY_REASON =
  /\b(?:credential|secret|private data|protected data|sensitive|prompt injection|system prompt|hidden instruction|exfiltrat)\b/i
const MAX_SCOPE_RELITIGATION_RESULT_BYTES = 64 * 1024

export const approvedSuccessfulResultBlockIsOnlyScopeRelitigation = (request: {
  readonly reason: string
  readonly content: unknown
  readonly isError: boolean
}): boolean => {
  if (
    (!SCOPE_RELITIGATION_REASON.test(request.reason) &&
      !EVIDENCE_RELITIGATION_REASON.test(request.reason)) ||
    RESULT_SAFETY_REASON.test(request.reason)
  )
    return false
  const serialized =
    typeof request.content === "string"
      ? request.content
      : (JSON.stringify(request.content) ?? "")
  return (
    Buffer.byteLength(serialized, "utf8") <=
      MAX_SCOPE_RELITIGATION_RESULT_BYTES &&
    !SENSITIVE_RESULT.test(serialized) &&
    !PROMPT_INJECTION_RESULT.test(serialized)
  )
}

export const deterministicReadOnlyToolResultDecision = (
  request: ToolResultRequest,
): Decision | null => {
  const registryCoordination =
    request.toolName === "agent_registry" &&
    REGISTRY_ACTIONS.has(String(request.input.action))
  const bridgeRouting =
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isPiBridgeRoutingCommand(request.input.command)
  const gitButlerStatusRead =
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isReadOnlyGitButlerStatusCommand(request.input.command)
  const gitWorkingTreeRead =
    request.toolName === "bash" &&
    typeof request.input.command === "string" &&
    isSafeBoundedGitWorkingTreeRead(request.input.command)
  if (
    !READ_ONLY_TOOLS.has(request.toolName) &&
    !registryCoordination &&
    !bridgeRouting &&
    !gitButlerStatusRead &&
    !gitWorkingTreeRead &&
    !isSkillView(request.toolName, request.input)
  ) {
    return null
  }
  const action = deterministicDecision({
    boundary: "action",
    toolName: request.toolName,
    input: request.input,
    cwd: request.cwd,
  })
  if (action?.verdict !== "allow") return null
  const serialized =
    typeof request.content === "string"
      ? request.content
      : (JSON.stringify(request.content) ?? "")
  if (
    SENSITIVE_RESULT.test(serialized) ||
    PROMPT_INJECTION_RESULT.test(serialized)
  )
    return null
  return {
    verdict: "allow",
    reason: "Bounded read-only result passed local sensitive-content guards",
    source: "deterministic",
  }
}

export function deterministicToolResultDecision(
  toolName: string,
): Decision | null {
  return LOCALLY_GENERATED_RESULT_TOOLS.has(toolName)
    ? {
        verdict: "allow",
        reason: "Locally generated mutation acknowledgement",
        source: "deterministic",
      }
    : null
}

export function parseClassifierDecision(text: string): Decision {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    if (isRecord(parsed)) {
      const { verdict, reason } = parsed
      const normalizedReason =
        typeof reason === "string" ? reason.trim() : undefined
      if (
        (verdict === "allow" ||
          verdict === "remediate" ||
          verdict === "block") &&
        normalizedReason !== undefined &&
        normalizedReason.length > 0 &&
        normalizedReason.length <= 2_000
      ) {
        return { verdict, reason: normalizedReason, source: "classifier" }
      }
    }
  } catch {
    // Fail closed below.
  }
  return {
    verdict: "block",
    reason: "Classifier returned an invalid decision",
    source: "classifier",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
