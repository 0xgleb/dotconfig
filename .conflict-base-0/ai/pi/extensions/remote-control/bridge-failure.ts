import type { RemoteMessage } from "./protocol.ts";

export const bridgeFailureText = (
  message: Extract<RemoteMessage, { readonly status: "failed" }>,
): string => {
  if (message.failure === "expired") {
    return message.claimedAt === undefined
      ? "This request expired before a Pi agent claimed it. It was not processed; the selected agent stayed busy or unavailable for the one-hour queue window. Check /agents, then retry once."
      : "A Pi agent claimed this request but did not finish within the one-hour response window. Completion is unknown; inspect the target agent before retrying.";
  }
  if (message.failure === "model_error") {
    return "The Pi model turn failed after the request was claimed. No successful response was recorded; inspect the target agent before retrying.";
  }
  if (message.failure === "bridge_disabled") {
    return "The Piece of Pi bridge was disabled before this request could complete. The request was not delivered.";
  }
  if (message.failure === "aborted") {
    return "The target Pi turn was aborted before a response completed. Completion was not recorded.";
  }
  return "The target Pi session ended before it could record a response. Check /agents before retrying.";
};
