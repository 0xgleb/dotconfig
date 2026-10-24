const PID_MARKER = ":pid:"

export interface RuntimeAgentIdentity {
  readonly sessionId: string
  readonly pid: number
}

export const runtimeAgentId: (sessionId: string, pid: number) => string = (
  sessionId,
  pid,
) => `${sessionId}${PID_MARKER}${pid}`

export const parseRuntimeAgentId: (
  agentId: string,
) => RuntimeAgentIdentity | undefined = agentId => {
  const marker = agentId.lastIndexOf(PID_MARKER)
  if (marker <= 0) return undefined
  const sessionId = agentId.slice(0, marker)
  const pidText = agentId.slice(marker + PID_MARKER.length)
  if (!/^[1-9][0-9]*$/u.test(pidText)) return undefined
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid)) return undefined
  return { sessionId, pid }
}

export const sameRuntimeSession = (left: string, right: string): boolean => {
  if (left === right) return true
  const leftIdentity = parseRuntimeAgentId(left)
  const rightIdentity = parseRuntimeAgentId(right)
  return (
    leftIdentity !== undefined &&
    rightIdentity !== undefined &&
    leftIdentity.sessionId === rightIdentity.sessionId
  )
}
