interface LiteralWord {
  readonly raw: string
  readonly value: string
  readonly quoted: boolean
}

// Deliberately narrower than Nushell: no expansions, concatenation or commands.
const literalWords = (command: string): readonly LiteralWord[] | undefined => {
  const words: LiteralWord[] = []
  let index = 0
  while (index < command.length) {
    while (command[index] === " " || command[index] === "\t") index += 1
    if (index === command.length) break
    const start = index
    const quote = command[index]
    if (quote === "'" || quote === '"') {
      index += 1
      const valueStart = index
      while (index < command.length && command[index] !== quote) {
        const character = command[index]
        if (
          !character ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(character)
        )
          return undefined
        if (quote === '"' && /[$`\\]/u.test(character)) return undefined
        index += 1
      }
      if (index === command.length) return undefined
      const value = command.slice(valueStart, index)
      index += 1
      if (
        index < command.length &&
        command[index] !== " " &&
        command[index] !== "\t"
      )
        return undefined
      words.push({ raw: command.slice(start, index), value, quoted: true })
    } else {
      while (
        index < command.length &&
        command[index] !== " " &&
        command[index] !== "\t"
      ) {
        const character = command[index]
        if (
          !character ||
          /[\s\u0000-\u001f\u007f'"#;&|<>`$\\(){}\[\]*?]/u.test(character)
        )
          return undefined
        index += 1
      }
      words.push({
        raw: command.slice(start, index),
        value: command.slice(start, index),
        quoted: false,
      })
    }
  }
  return words.length > 0 ? words : undefined
}

const diskLiteralArguments = (
  words: readonly LiteralWord[],
): ReadonlySet<number> | undefined => {
  const literals = new Set<number>()
  let operands = false
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (!word) return undefined
    if (operands) {
      if (word.value.startsWith("-")) return undefined
      continue
    }
    if (word.value === "--") {
      operands = true
    } else if (word.value === "-I") {
      const value = words[index + 1]
      if (!value || (!value.quoted && value.value.startsWith("-")))
        return undefined
      literals.add(index + 1)
      index += 1
    } else if (/^-[shakmxc]+$/u.test(word.value)) {
      continue
    } else if (word.value.startsWith("-")) {
      return undefined
    } else {
      operands = true
    }
  }
  return literals
}

const issueLiteralArguments = (
  words: readonly LiteralWord[],
): ReadonlySet<number> | undefined => {
  if (words[1]?.value !== "issue" || words[2]?.value !== "create")
    return undefined
  const literals = new Set<number>()
  for (let index = 3; index < words.length; index += 2) {
    const option = words[index]?.value
    const value = words[index + 1]
    if (!value || value.value.startsWith("-")) return undefined
    if (option === "--body" || option === "--title") {
      literals.add(index + 1)
    } else if (option !== "--repo" && option !== "--body-file") {
      return undefined
    }
  }
  return literals
}

// Only the protected-path scan consumes this view. The classifier and executor
// still receive the complete original command, including all publication prose.
export const maskLiteralNonPathArguments = (command: string): string => {
  const words = literalWords(command)
  if (!words || words[0]?.quoted) return command
  const executable = words[0]?.value
  const literals =
    executable === "^du"
      ? diskLiteralArguments(words)
      : executable === "gh" || executable === "^gh"
        ? issueLiteralArguments(words)
        : undefined
  if (!literals) return command
  return words
    .map((word, index) => (literals.has(index) ? "NON_PATH_LITERAL" : word.raw))
    .join(" ")
}
