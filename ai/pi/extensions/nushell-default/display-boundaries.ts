// Only reflow single-line input whose delimiters can be classified reliably.
export const breakAtNushellBoundaries = (
  text: string,
  width: number,
): string => {
  if (text.length <= width || /[\n\r\u001b]/u.test(text)) return text
  const stack: string[] = []
  const breaks: Array<{ index: number; indent: string }> = []
  let quote: '"' | "'" | undefined
  let bodyStart = -1
  let bodyEnd = -1
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
      const statement = text.slice(preceding?.index ?? 0, index).trim()
      const parameters = /^\{\|[\w\s,]*\|/u.exec(text.slice(index))
      if (
        char === "{" &&
        !closure &&
        parameters &&
        /^(?:\|\s*)?where$/u.test(statement)
      ) {
        const indent = preceding?.indent ?? ""
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
        breaks.push({ index: index + 1, indent: inBody ? "  " : "" })
      if (char === "|" && text[index - 1] === " " && text[index + 1] === " ") {
        breaks.push({ index, indent: inBody ? "    " : "  " })
      }
    }
  }
  if (quote || stack.length > 0 || breaks.length === 0) return text

  let offset = 0
  let indent = ""
  const rows = breaks.map(boundary => {
    const row = indent + text.slice(offset, boundary.index).trim()
    offset = boundary.index
    indent = boundary.indent
    return row
  })
  return [...rows, indent + text.slice(offset).trim()].join("\n")
}
