export const commandOutcome = (
  failed: boolean,
  text: string,
  started: boolean,
) => {
  const refusal =
    failed && !started
      ? /^(?:Auto-classifier verdict|Deterministic policy verdict|Classifier remediation required):\s*/u.exec(
          text,
        )
      : null
  if (refusal) return { icon: "▲", explanation: text.slice(refusal[0].length) }
  return { icon: failed ? (started ? "✖" : "▲") : "●✓", explanation: text }
}
