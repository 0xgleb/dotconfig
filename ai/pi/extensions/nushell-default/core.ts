import { existsSync } from "node:fs"

export class NushellUnavailableError extends Error {
  readonly name = "NushellUnavailableError"
}

export type PathExists = (path: string) => boolean

export type PreviewLineWrapper = (line: string, width: number) => string[]

const DEFAULT_NUSHELL_TABLE_WIDTH = 80
const PI_TOOL_CHROME_COLUMNS = 6

export const resolveNushellTableWidth = (
  tuiWidth: number | undefined,
  stdoutColumns: number | undefined,
  stderrColumns: number | undefined,
): number => {
  if (typeof tuiWidth === "number" && Number.isFinite(tuiWidth) && tuiWidth > 0)
    return Math.max(1, Math.floor(tuiWidth))

  const terminalWidth = [stdoutColumns, stderrColumns].find(
    width => typeof width === "number" && Number.isFinite(width) && width > 0,
  )
  return terminalWidth === undefined
    ? DEFAULT_NUSHELL_TABLE_WIDTH
    : Math.max(1, Math.floor(terminalWidth) - PI_TOOL_CHROME_COLUMNS)
}

export const nushellTableWidthPrefix = (width: number): string =>
  `$env.config.hooks.display_output = { table --width ${Math.max(1, Math.floor(width))} }`

const wrapPreviewLine: PreviewLineWrapper = (line, width) => {
  if (line.length === 0) return [""]

  const lines: string[] = []
  let remaining = line
  while (remaining.length > width) {
    let breakAt = -1
    for (let index = width; index > 0; index -= 1) {
      if (/\s/.test(remaining[index] ?? "")) {
        breakAt = index
        break
      }
    }
    if (breakAt < 1) breakAt = width

    const wrappedLine = remaining.slice(0, breakAt).trimEnd()
    lines.push(wrappedLine || remaining.slice(0, width))
    remaining = remaining.slice(breakAt)
    if (/^\s/.test(remaining)) remaining = remaining.trimStart()
  }
  lines.push(remaining)
  return lines
}

export const nushellCommandPreviewLines = (
  command: string,
  width: number,
  wrapLine: PreviewLineWrapper = wrapPreviewLine,
): string[] => {
  const safeWidth = Math.max(1, Math.floor(width))
  const markerWidth = safeWidth >= 3 ? 2 : 0
  const contentWidth = Math.max(1, safeWidth - markerWidth)

  const sourceLines = command.split("\n")
  const firstCommandLine = sourceLines.findIndex(line => line.length > 0)
  return sourceLines.flatMap((sourceLine, sourceLineIndex) => {
    if (sourceLine.length === 0) return [""]
    const wrapped = wrapLine(sourceLine, contentWidth)
    if (markerWidth === 0) return wrapped

    return wrapped.map(
      (line, wrappedLineIndex) =>
        `${
          sourceLineIndex === firstCommandLine && wrappedLineIndex === 0
            ? "$ "
            : "  "
        }${line}`,
    )
  })
}

export const nushellToolPreviewLines = (
  command: string,
  timeout: number | undefined,
  width: number,
  wrapLine: PreviewLineWrapper = wrapPreviewLine,
): { readonly commandLines: string[]; readonly timeoutLines: string[] } => {
  const safeWidth = Math.max(1, Math.floor(width))
  return {
    commandLines: nushellCommandPreviewLines(command, safeWidth, wrapLine),
    timeoutLines: timeout ? wrapLine(`timeout ${timeout}s`, safeWidth) : [],
  }
}

export const resolveNushellPath = (
  home: string | undefined,
  pathExists: PathExists = existsSync,
): string => {
  const managedPaths = [
    "/run/current-system/sw/bin/nu",
    ...(home ? [`${home}/.nix-profile/bin/nu`] : []),
  ]
  const nushellPath = managedPaths.find(pathExists)
  if (nushellPath) return nushellPath
  throw new NushellUnavailableError("Nushell executable was not found")
}
