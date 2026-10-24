export const shouldDetachForegroundWorkflow = (
  streamingBehavior: "steer" | "followUp",
  source: "interactive" | "rpc" | "extension",
  hasForegroundWorkflow: boolean,
): boolean =>
  streamingBehavior === "steer" &&
  (source === "interactive" || source === "rpc") &&
  hasForegroundWorkflow
