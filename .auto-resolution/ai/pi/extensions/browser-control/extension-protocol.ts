import { Data, Effect } from "effect";
import type { BrowserAction } from "./core.ts";

/**
 * Versioned wire protocol between the Pi browser-control host and the
 * dedicated agent-profile browser extension (ADR 08). The extension dials
 * the host's loopback WebSocket, authenticates with a provisioned token in
 * its hello frame, executes act frames through extension APIs, renders
 * overlay frames in-page, and answers every act with exactly one result
 * frame. Both ends decode fail-closed: an unknown version, kind, field, or
 * bound violation rejects the whole frame.
 */
export const EXTENSION_PROTOCOL_VERSION = 1;

export const MAX_TEXT_CHARS = 512_000;
export const MAX_TAB_SUMMARIES = 64;

export class BrowserProtocolError extends Data.TaggedError("BrowserProtocolError")<{
  readonly code: "invalid_frame";
  readonly message: string;
}> {}

interface FrameBase {
  readonly version: typeof EXTENSION_PROTOCOL_VERSION;
  readonly requestId: string;
}

export type ActFrame =
  | (FrameBase & { readonly kind: "act"; readonly action: "status" })
  | (FrameBase & { readonly kind: "act"; readonly action: "open"; readonly url: string })
  | (FrameBase & { readonly kind: "act"; readonly action: "text" })
  | (FrameBase & { readonly kind: "act"; readonly action: "fetch"; readonly url: string });

export interface OverlayFrame extends FrameBase {
  readonly kind: "overlay";
  readonly phase: "start" | "finish";
  readonly label: string;
}

export type HostFrame = ActFrame | OverlayFrame;

export interface HelloFrame {
  readonly version: typeof EXTENSION_PROTOCOL_VERSION;
  readonly kind: "hello";
  readonly token: string;
  readonly profilePath: string;
}

export interface TabSummary {
  readonly title: string;
  readonly url: string;
}

export type ResultPayload =
  | { readonly action: "status"; readonly tabs: readonly TabSummary[] }
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "text"; readonly text: string }
  | { readonly action: "fetch"; readonly text: string };

export type ResultFrame =
  | (FrameBase & {
      readonly kind: "result";
      readonly outcome: "completed";
      readonly payload: ResultPayload;
    })
  | (FrameBase & {
      readonly kind: "result";
      readonly outcome: "failed";
      readonly error: string;
    });

export type ExtensionFrame = HelloFrame | ResultFrame;

export const decodeExtensionFrame: (
  value: unknown,
) => Effect.Effect<ExtensionFrame, BrowserProtocolError> = (value) => {
  if (!isRecord(value) || value.version !== EXTENSION_PROTOCOL_VERSION) {
    return invalid("extension frame must carry the supported protocol version");
  }
  if (value.kind === "hello") {
    if (
      !hasOnlyKeys(value, ["version", "kind", "token", "profilePath"]) ||
      !isSafeIdentifier(value.token, MIN_TOKEN_CHARS, MAX_TOKEN_CHARS) ||
      typeof value.profilePath !== "string" ||
      !value.profilePath.startsWith("/") ||
      !isBoundedPrintable(value.profilePath, MAX_PATH_CHARS)
    ) {
      return invalid("hello frame requires a bounded token and absolute profile path");
    }
    return Effect.succeed({
      version: EXTENSION_PROTOCOL_VERSION,
      kind: "hello",
      token: value.token,
      profilePath: value.profilePath,
    });
  }
  if (value.kind === "result") {
    if (!isSafeIdentifier(value.requestId, 1, MAX_IDENTIFIER_CHARS)) {
      return invalid("result frame requires a bounded safe request id");
    }
    const requestId = value.requestId;
    if (value.outcome === "failed") {
      if (
        !hasOnlyKeys(value, ["version", "kind", "requestId", "outcome", "error"]) ||
        !isBoundedPrintable(value.error, MAX_ERROR_CHARS)
      ) {
        return invalid("failed result carries only a bounded error");
      }
      return Effect.succeed({
        version: EXTENSION_PROTOCOL_VERSION,
        kind: "result",
        requestId,
        outcome: "failed",
        error: value.error,
      });
    }
    if (
      value.outcome !== "completed" ||
      !hasOnlyKeys(value, ["version", "kind", "requestId", "outcome", "payload"])
    ) {
      return invalid("result frame outcome must be completed or failed");
    }
    return Effect.map(decodeResultPayload(value.payload), (payload) => ({
      version: EXTENSION_PROTOCOL_VERSION,
      kind: "result" as const,
      requestId,
      outcome: "completed" as const,
      payload,
    }));
  }
  return invalid("extension frame kind is unknown");
};

export const decodeHostFrame: (
  value: unknown,
) => Effect.Effect<HostFrame, BrowserProtocolError> = (value) => {
  if (
    !isRecord(value) ||
    value.version !== EXTENSION_PROTOCOL_VERSION ||
    !isSafeIdentifier(value.requestId, 1, MAX_IDENTIFIER_CHARS)
  ) {
    return invalid("host frame must carry the supported version and a safe request id");
  }
  const requestId = value.requestId;
  if (value.kind === "overlay") {
    if (
      !hasOnlyKeys(value, ["version", "kind", "requestId", "phase", "label"]) ||
      (value.phase !== "start" && value.phase !== "finish") ||
      !isBoundedPrintable(value.label, MAX_LABEL_CHARS)
    ) {
      return invalid("overlay frame requires a typed phase and bounded printable label");
    }
    return Effect.succeed({
      version: EXTENSION_PROTOCOL_VERSION,
      kind: "overlay",
      requestId,
      phase: value.phase,
      label: value.label,
    });
  }
  if (value.kind !== "act") return invalid("host frame kind is unknown");
  if (value.action === "status" || value.action === "text") {
    if (!hasOnlyKeys(value, ["version", "kind", "requestId", "action"])) {
      return invalid(`${value.action} act frames carry no parameters`);
    }
    return Effect.succeed({
      version: EXTENSION_PROTOCOL_VERSION,
      kind: "act",
      requestId,
      action: value.action,
    });
  }
  if (value.action === "open" || value.action === "fetch") {
    if (
      !hasOnlyKeys(value, ["version", "kind", "requestId", "action", "url"]) ||
      !isBoundedPrintable(value.url, MAX_URL_CHARS)
    ) {
      return invalid(`${value.action} act frames require a bounded url`);
    }
    return Effect.succeed({
      version: EXTENSION_PROTOCOL_VERSION,
      kind: "act",
      requestId,
      action: value.action,
      url: value.url,
    });
  }
  return invalid("act frame action is not registered");
};

export const resultMatchesAction: (frame: ResultFrame, action: BrowserAction) => boolean = (
  frame,
  action,
) => frame.outcome === "failed" || frame.payload.action === action;

const MIN_TOKEN_CHARS = 32;
const MAX_TOKEN_CHARS = 256;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_LABEL_CHARS = 120;
const MAX_URL_CHARS = 2_048;
const MAX_ERROR_CHARS = 2_000;
const MAX_PATH_CHARS = 1_024;
const MAX_TAB_TITLE_CHARS = 300;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u;
const UNSAFE_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "u");

const invalid = <A>(message: string): Effect.Effect<A, BrowserProtocolError> =>
  Effect.fail(new BrowserProtocolError({ code: "invalid_frame", message }));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isSafeIdentifier = (value: unknown, minimum: number, maximum: number): value is string =>
  typeof value === "string" &&
  value.length >= minimum &&
  value.length <= maximum &&
  SAFE_IDENTIFIER.test(value);

const isBoundedPrintable = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  !UNSAFE_CONTROL.test(value);

const decodeTabSummary = (value: unknown): TabSummary | undefined =>
  isRecord(value) &&
  hasOnlyKeys(value, ["title", "url"]) &&
  isBoundedPrintable(value.title, MAX_TAB_TITLE_CHARS) &&
  isBoundedPrintable(value.url, MAX_URL_CHARS)
    ? { title: value.title, url: value.url }
    : undefined;

const decodeResultPayload = (
  value: unknown,
): Effect.Effect<ResultPayload, BrowserProtocolError> => {
  if (!isRecord(value)) return invalid("completed result requires a typed payload");
  if (value.action === "status") {
    if (
      !hasOnlyKeys(value, ["action", "tabs"]) ||
      !Array.isArray(value.tabs) ||
      value.tabs.length > MAX_TAB_SUMMARIES
    ) {
      return invalid("status payload requires a bounded tab list");
    }
    const tabs: TabSummary[] = [];
    for (const candidate of value.tabs) {
      const tab = decodeTabSummary(candidate);
      if (tab === undefined) {
        return invalid("status payload tabs must be bounded printable summaries");
      }
      tabs.push(tab);
    }
    return Effect.succeed({ action: "status", tabs });
  }
  if (value.action === "open") {
    if (!hasOnlyKeys(value, ["action", "url"]) || !isBoundedPrintable(value.url, MAX_URL_CHARS)) {
      return invalid("open payload requires a bounded url");
    }
    return Effect.succeed({ action: "open", url: value.url });
  }
  if (value.action === "text" || value.action === "fetch") {
    if (
      !hasOnlyKeys(value, ["action", "text"]) ||
      typeof value.text !== "string" ||
      value.text.length > MAX_TEXT_CHARS
    ) {
      return invalid("text payloads carry only bounded page text");
    }
    return Effect.succeed({ action: value.action, text: value.text });
  }
  return invalid("result payload action is not registered");
};
