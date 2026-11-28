export const commandOutcome = (
  failed: boolean,
  text: string,
  started: boolean,
  details?: unknown,
) => {
  const blocked =
    typeof details === "object" &&
    details !== null &&
    "blockedBeforeExecution" in details &&
    details.blockedBeforeExecution === true
  const refusal =
    failed && (blocked || !started)
      ? /^(?:Auto-classifier verdict|Deterministic policy verdict|Classifier remediation required):\s*/u.exec(
          text,
        )
      : null
  if (refusal) return { icon: "▲", explanation: text.slice(refusal[0].length) }
  return {
    icon: failed ? (started && !blocked ? "✖" : "▲") : "●✓",
    explanation: text,
  }
}
