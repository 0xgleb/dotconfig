import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"
import { resolveNushellPath } from "./core.ts"

export const highlightNushellPreview = (text: string): string | undefined => {
  if (Buffer.byteLength(text) > 32_768) return undefined
  const executable = Effect.runSync(
    Effect.option(resolveNushellPath(homedir())),
  )
  if (executable._tag === "None") return undefined
  const result = spawnSync(
    executable.value,
    [
      "--no-config-file",
      "--stdin",
      "-c",
      "$in | nu-highlight | print --no-newline",
    ],
    {
      input: text,
      encoding: "utf8",
      timeout: 200,
      maxBuffer: 262_144,
      shell: false,
      killSignal: "SIGKILL",
    },
  )
  return result.status === 0 && !result.error ? result.stdout : undefined
}

const runNufmt = (raw: string): string | undefined => {
  if (Buffer.byteLength(raw) > 32_768) return undefined
  const result = spawnSync(
    join(homedir(), ".pi/agent/bin/nufmt"),
    ["--stdin"],
    {
      input: raw,
      encoding: "utf8",
      timeout: 200,
      maxBuffer: 65_536,
      shell: false,
      killSignal: "SIGKILL",
    },
  )
  return result.status === 0 && !result.error
    ? result.stdout.trimEnd()
    : undefined
}

export const formatCommandForDisplay = (
  raw: string,
  format: (text: string) => string | undefined = runNufmt,
): string => format(raw) || raw
