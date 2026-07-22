export const BROWSER_ACTIONS = ["status", "open", "text"] as const;

export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export type BrowserActivity = "active" | "idle";

export const browserActivityLabel: (activity: BrowserActivity, action?: BrowserAction) => string = (activity, action) =>
  activity === "active" && action ? `browser:active:${action} · isolated` : `browser:${activity} · isolated`;

declare const localPageUrlBrand: unique symbol;
export type LocalPageUrl = string & { readonly [localPageUrlBrand]: true };

export interface DebugTarget {
  readonly id: string;
  readonly title: string;
  readonly url: LocalPageUrl;
  readonly type: "page";
  readonly webSocketDebuggerUrl: string;
}

export interface LaunchServicesRequest {
  readonly command: "/usr/bin/open";
  readonly args: readonly [
    "-n",
    "-a",
    "Brave Browser",
    "--args",
    `--user-data-dir=${string}`,
    `--remote-debugging-port=${number}`,
    "--no-first-run",
    "--no-default-browser-check",
    LocalPageUrl,
  ];
}

export type PublicDebugTarget = Omit<DebugTarget, "webSocketDebuggerUrl">;

export type CdpResponse =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly message: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const launchServicesRequest: (
  url: LocalPageUrl,
  operatorProfilePath: string,
  debugPort: number,
) => LaunchServicesRequest = (url, operatorProfilePath, debugPort) => {
  if (!operatorProfilePath.startsWith("/")) throw new Error("Operator profile path must be absolute.");
  if (!Number.isSafeInteger(debugPort) || debugPort < 1_024 || debugPort > 65_535) {
    throw new Error("Operator debugging port is invalid.");
  }
  return {
    command: "/usr/bin/open",
    args: [
      "-n",
      "-a",
      "Brave Browser",
      "--args",
      `--user-data-dir=${operatorProfilePath}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
  };
};

export const parseLocalPageUrl: (input: string) => LocalPageUrl = (input) => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Browser URLs must be absolute loopback HTTP URLs.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URLs must use HTTP or HTTPS.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Browser URLs must use an exact loopback host.");
  }
  if (url.username || url.password) {
    throw new Error("Browser URLs must not contain credentials.");
  }
  return url.href as LocalPageUrl;
};

export const parseDebugTargets: (value: unknown, debugPort: number) => readonly DebugTarget[] = (
  value,
  debugPort,
) => {
  if (!Array.isArray(value)) throw new Error("Brave debug target response must be an array.");
  return value.flatMap((candidate) => {
    const target = parseDebugTarget(candidate, debugPort);
    return target ? [target] : [];
  });
};

export const selectReusableTarget: (
  targets: readonly DebugTarget[],
  url: LocalPageUrl,
  preferredTargetId: string | undefined,
) => DebugTarget | undefined = (targets, url, preferredTargetId) =>
  targets.find((target) => target.id === preferredTargetId && target.url === url) ??
  targets.find((target) => target.url === url);

export const selectActiveTarget: (
  targets: readonly DebugTarget[],
  activeTargetId: string | undefined,
) => DebugTarget = (targets, activeTargetId) => {
  if (!activeTargetId) throw new Error("No explicitly opened local page is available.");
  const target = targets.find((candidate) => candidate.id === activeTargetId);
  if (!target) throw new Error("The explicitly opened local page is no longer available.");
  return target;
};

export const publicTarget: (target: DebugTarget) => PublicDebugTarget = (target) => {
  return {
    id: target.id,
    title: target.title,
    type: target.type,
    url: target.url,
  };
};

export const parseCdpResponse: (data: string) => CdpResponse | undefined = (data) => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Brave returned malformed CDP JSON.");
  }
  if (!isRecord(value)) throw new Error("Brave returned a malformed CDP response.");
  if (!("id" in value)) return undefined;
  if (!Number.isSafeInteger(value.id) || Number(value.id) < 1) {
    throw new Error("Brave returned a CDP response with an invalid id.");
  }
  const id = Number(value.id);
  if ("error" in value) {
    if (!isRecord(value.error)) throw new Error("Brave returned a malformed CDP error.");
    const dataMessage = typeof value.error.data === "string" ? value.error.data : undefined;
    const message = typeof value.error.message === "string" ? value.error.message : undefined;
    return { kind: "error", id, message: dataMessage ?? message ?? "CDP command failed" };
  }
  return { kind: "result", id, result: value.result };
};

export const parseEvaluationResult: (value: unknown) => unknown = (value) => {
  if (!isRecord(value)) throw new Error("Brave returned a malformed Runtime.evaluate result.");
  if ("exceptionDetails" in value) {
    if (!isRecord(value.exceptionDetails)) {
      throw new Error("Brave returned malformed Runtime.evaluate exception details.");
    }
    const exception = isRecord(value.exceptionDetails.exception) ? value.exceptionDetails.exception : undefined;
    const description = exception && typeof exception.description === "string" ? exception.description : undefined;
    const text = typeof value.exceptionDetails.text === "string" ? value.exceptionDetails.text : undefined;
    throw new Error(description ?? text ?? "Runtime.evaluate failed.");
  }
  if (!isRecord(value.result) || typeof value.result.type !== "string") {
    throw new Error("Brave returned a malformed Runtime.evaluate result.");
  }
  if ("value" in value.result) return value.result.value;
  return typeof value.result.description === "string" ? value.result.description : undefined;
};

const parseDebugTarget: (value: unknown, debugPort: number) => DebugTarget | undefined = (
  value,
  debugPort,
) => {
  if (!isRecord(value)) throw new Error("Brave returned a malformed debug target.");
  if (value.type !== "page") return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.url !== "string" ||
    typeof value.webSocketDebuggerUrl !== "string"
  ) {
    throw new Error("Brave returned a malformed page target.");
  }

  let url: LocalPageUrl;
  try {
    url = parseLocalPageUrl(value.url);
  } catch {
    return undefined;
  }
  validateDebuggerUrl(value.webSocketDebuggerUrl, value.id, debugPort);
  return {
    id: value.id,
    title: value.title,
    type: value.type,
    url,
    webSocketDebuggerUrl: value.webSocketDebuggerUrl,
  };
};

const validateDebuggerUrl: (input: string, targetId: string, debugPort: number) => void = (
  input,
  targetId,
  debugPort,
) => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Brave returned an invalid debugging endpoint.");
  }
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.port !== String(debugPort) ||
    url.pathname !== `/devtools/page/${targetId}`
  ) {
    throw new Error("Brave returned an unexpected debugging endpoint.");
  }
};

const isRecord: (value: unknown) => value is Readonly<Record<string, unknown>> = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
