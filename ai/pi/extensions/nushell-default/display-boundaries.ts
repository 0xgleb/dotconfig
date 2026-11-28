// Match only plain list elements and complete quote-delimited literals.
const loopListHeader =
  /^( *)(for [\w-]+ in \[)( *(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[\w./-]+)(?: +(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[\w./-]+))* *)\]( \{)$/u
const listElement = /"(?:[^"\\]|\\.)*"|'[^']*'|[\w./-]+/gu

const reflowLoopList = (text: string, width: number): string => {
  const newline = text.indexOf("\n")
  const header = newline < 0 ? text : text.slice(0, newline)
  if (header.length <= width) return text
  const match = loopListHeader.exec(header)
  if (!match) return text
  const [, indent, prefix, list, suffix] = match
  const elements = list?.match(listElement)
  if (!elements || elements.length < 2) return text
  return (
    [
      `${indent}${prefix}`,
      ...elements.map(element => `${indent}  ${element}`),
      `${indent}]${suffix}`,
    ].join("\n") + (newline < 0 ? "" : text.slice(newline))
  )
}

// Preserve source when the boundaries cannot be classified reliably.
export const breakAtNushellBoundaries = (
  text: string,
  width: number,
  keepClosurePipeline = false,
): string => {
  if (text.length <= width || /[\r\u001b]/u.test(text)) return text
  if (text.includes("\n")) return reflowLoopList(text, width)
  const stack: string[] = []
  const breaks: Array<{ index: number; indent: string; statementEnd?: true }> =
    []
  let quote: '"' | "'" | undefined
  let bodyStart = -1
  let bodyEnd = -1
  let lastPipe = -1
  let expandedClosure = false
  let closure: { depth: number; indent: string } | undefined

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (quote === '"' && char === "\\") index++
      else if (char === quote) quote = undefined
      continue
    }
    if (
      char === "#" ||
      char === "`" ||
      char === "\\" ||
      text.startsWith('$"', index) ||
      text.startsWith("$'", index)
    )
      return text
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{" || char === "[" || char === "(") {
      if (
        char === "{" &&
        stack.length === 0 &&
        /^with-env\s+\{.*\}\s*$/u.test(text.slice(0, index))
      ) {
        if (bodyStart !== -1) return text
        bodyStart = index
        breaks.push({ index: index + 1, indent: "  " })
      }
      const preceding = breaks.at(-1)
      const statement = text
        .slice(Math.max(preceding?.index ?? 0, lastPipe), index)
        .trim()
      const parameters = /^\{\|[\w\s,]*\|/u.exec(text.slice(index))
      if (
        char === "{" &&
        !closure &&
        parameters &&
        /^(?:\|\s*)?where$/u.test(statement)
      ) {
        const indent = preceding?.indent ?? ""
        expandedClosure = true
        closure = { depth: stack.length, indent }
        breaks.push({
          index: index + parameters[0].length,
          indent: `${indent}  `,
        })
        index += parameters[0].length - 1
      }
      stack.push(char)
    } else if (char === "}" || char === "]" || char === ")") {
      if (stack.pop() !== { "}": "{", "]": "[", ")": "(" }[char]) return text
      if (char === "}" && closure?.depth === stack.length) {
        breaks.push({ index, indent: closure.indent })
        closure = undefined
      }
      if (char === "}" && stack.length === 0 && bodyStart >= 0 && bodyEnd < 0) {
        bodyEnd = index
        breaks.push({ index, indent: "" })
      }
    } else {
      const inBody = bodyStart >= 0 && bodyEnd < 0 && stack.length === 1
      if (stack.length !== 0 && !inBody) continue
      if (char === ";")
        breaks.push({
          index: index + 1,
          indent: inBody ? "  " : "",
          ...(inBody ? {} : { statementEnd: true }),
        })
      if (char === "|" && text[index - 1] === " " && text[index + 1] === " ") {
        lastPipe = index
        if (!keepClosurePipeline)
          breaks.push({ index, indent: inBody ? "    " : "  " })
      }
    }
  }
  if (quote || stack.length > 0) return text
  if (breaks.length === 0) {
    const command = text.trim()
    if (!/^\^[a-zA-Z][\w-]*(?: +[a-zA-Z0-9][\w.-]*){2,}$/u.test(command))
      return text
    const [head, ...args] = command.split(/ +/u)
    return [`(${head}`, ...args.map(arg => `  ${arg}`), ")"].join("\n")
  }

  let offset = 0
  let indent = ""
  const statements: string[][] = []
  const finish = (lines: string[]) => {
    const first = lines[0]
    const command = first?.replace(/;$/u, "")
    if (lines.length === 1 && first && command && first.length > width) {
      const expanded = breakAtNushellBoundaries(command, width)
      if (expanded.includes("\n")) {
        statements.push(
          (expanded + (first.endsWith(";") ? ";" : "")).split("\n"),
        )
        return
      }
    }
    statements.push(lines)
  }
  let rows: string[] = []
  for (const boundary of breaks) {
    const segment = text.slice(offset, boundary.index).trim()
    const row = indent + segment
    rows.push(row)
    if (boundary.statementEnd) {
      finish(rows)
      rows = []
    }
    offset = boundary.index
    indent = boundary.indent
  }
  const tail = text.slice(offset).trim()
  if (tail || rows.length > 0) finish([...rows, indent + tail])
  if (expandedClosure && !keepClosurePipeline && width > 0) {
    const inline = breakAtNushellBoundaries(text, 0, true)
    if (inline.split("\n").every(line => line.length <= width)) return inline
  }
  return statements
    .map((lines, index) => {
      const previous = statements[index - 1]
      const space =
        previous && (previous.length > 1 || lines.length > 1) ? "\n" : ""
      return space + lines.join("\n")
    })
    .join("\n")
}
