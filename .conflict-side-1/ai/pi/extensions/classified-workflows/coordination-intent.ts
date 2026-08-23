const REGISTRY_MESSAGE_TYPE = "agent-registry.message"

const isRecord: (value: unknown) => value is Record<string, unknown> = value =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const textContent: (content: unknown) => string | undefined = content => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map(part => String(part.text))
    .join("\n")
  return text || undefined
}

export const trustedCoordinationIntent: (
  message: unknown,
) => string | undefined = message => {
  if (
    !isRecord(message) ||
    message.role !== "custom" ||
    message.customType !== REGISTRY_MESSAGE_TYPE
  ) {
    return undefined
  }
  const text = textContent(message.content)
  return text
    ? `Trusted registry coordination: ${text.slice(0, 4_000)}`
    : undefined
}
