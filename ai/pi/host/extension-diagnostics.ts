import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
} from "node:fs"

export const createExtensionDiagnostics = (path: string) => {
  let previous: string | undefined
  let identity: { dev: number; ino: number } | undefined

  return {
    record: (source: string, error: string, stack: string) => {
      const message =
        `Extension ${source}: ${error}`
          .split(/\r?\n/u, 1)[0]
          ?.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
          .slice(0, 500) ?? "Extension error"
      const unavailable = { kind: "unavailable" as const, message }
      try {
        const flags =
          constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK
        const fd = openSync(
          path,
          identity ? flags : flags | constants.O_CREAT | constants.O_EXCL,
          0o600,
        )
        try {
          const stat = fstatSync(fd)
          if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o777) !== 0o600
          )
            return unavailable
          if (
            identity &&
            (stat.dev !== identity.dev || stat.ino !== identity.ino)
          )
            return unavailable
          identity = { dev: stat.dev, ino: stat.ino }
          appendFileSync(fd, `${JSON.stringify({ source, error, stack })}\n`)
        } finally {
          closeSync(fd)
        }
      } catch {
        return unavailable
      }
      if (previous === message) return { kind: "repeat" as const }
      previous = message
      return { kind: "new" as const, message, path }
    },
  }
}
