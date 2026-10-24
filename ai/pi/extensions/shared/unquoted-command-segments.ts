/**
 * Shared quote-aware command scanning.
 *
 * Only text outside quotes can form an executable invocation — except that
 * command substitutions inside double quotes and quoted words in command
 * position DO execute. Quoted arguments stay data: prose naming a command
 * never trips gates that classify executable intent, while real commands
 * stay gated however deep the composition. An unquoted backslash escapes
 * the next character, so shell-escaped spellings stay visible to gates too.
 */

// Prefixes that still leave a following quoted word in executable position.
export const WRAPPER_COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "nice",
  "nohup",
  "env",
  "command",
  "time",
  "watch",
  "strace",
  "stdbuf",
  "xargs",
])

const wordStart = (scanned: string): string =>
  scanned.replace(/[^\s;&|(]+$/, "")

const atCommandPosition = (scanned: string): boolean => {
  const significantTail = wordStart(scanned).trimEnd()
  if (significantTail.length === 0) return true
  if (/[;&|(\r\n]$/.test(significantTail)) return true
  // A wrapper prefix or environment assignment leaves the next quoted
  // word in executable position.
  const lastWord = significantTail.split(/\s+/).at(-1) ?? ""
  return (
    WRAPPER_COMMAND_PREFIXES.has(lastWord) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(lastWord)
  )
}

export const unquotedCommandSegments = (command: string): string => {
  let result = ""
  let quote: "single" | "double" | undefined
  let quotedAtBoundary = false
  let escaped = false
  let escapedInDouble = false
  let parenSubstitutionDepth = 0
  let inBacktickSubstitution = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === undefined) continue
    if (escaped) {
      escaped = false
      result += character
      continue
    }
    if (quote === "single") {
      if (character === "'") quote = undefined
      else if (quotedAtBoundary) result += character
      continue
    }
    if (quote === "double") {
      if (escapedInDouble) {
        escapedInDouble = false
        continue
      }
      if (parenSubstitutionDepth > 0) {
        if (character === "(") parenSubstitutionDepth += 1
        else if (character === ")") {
          parenSubstitutionDepth -= 1
          if (parenSubstitutionDepth === 0) {
            result += " "
            continue
          }
        }
        result += character
        continue
      }
      if (inBacktickSubstitution) {
        if (character === "`") {
          inBacktickSubstitution = false
          result += " "
          continue
        }
        result += character
        continue
      }
      if (character === "\\") {
        escapedInDouble = true
        continue
      }
      if (character === '"') {
        quote = undefined
        continue
      }
      if (character === "$" && command[index + 1] === "(") {
        parenSubstitutionDepth = 1
        // A substitution body is itself a command position; mark it so
        // downstream gates see the boundary.
        result += ";"
        index += 1
        continue
      }
      if (character === "`") {
        inBacktickSubstitution = true
        result += ";"
        continue
      }
      if (quotedAtBoundary) result += character
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === "'") {
      quote = "single"
      quotedAtBoundary = atCommandPosition(result)
      continue
    }
    if (character === '"') {
      quote = "double"
      quotedAtBoundary = atCommandPosition(result)
      continue
    }
    result += character
  }
  return result
}
