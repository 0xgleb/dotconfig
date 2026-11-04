const mode = process.argv[2]

let input = ""

process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  input += chunk
})
process.stdin.on("end", () => {
  if (mode === "hang") {
    process.stdout.write("ready\n")
    setInterval(() => {}, 1_000)
    return
  }
  if (mode === "nonzero") {
    process.stderr.write("Private CLI diagnostic", () => process.exit(7))
    return
  }
  if (mode === "invalid-utf8") {
    process.stdout.write(Buffer.from([0xff]), () => process.exit(0))
    return
  }
  if (mode === "bad-json") {
    process.stdout.write("{", () => process.exit(0))
    return
  }

  const request = JSON.parse(input)
  const variables = request.variables
  const repository = `${variables.owner}/${variables.name}`
  const number = variables.number ?? 1

  const row = {
    number,
    title: JSON.stringify(request),
    url: `https://github.com/${repository}/issues/${number}`,
    state: variables.states?.[0] ?? "OPEN",
    updatedAt: "2026-10-20T20:14:47Z",
    repository: { nameWithOwner: repository },
  }

  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }

  const data =
    variables.number === undefined
      ? {
          repository: {
            nameWithOwner: repository,
            issues: { nodes: [row], pageInfo: empty.pageInfo },
          },
        }
      : {
          repository: {
            nameWithOwner: repository,
            issue: {
              ...row,
              body: JSON.stringify(request),
              parent: null,
              blockedBy: empty,
              closedByPullRequestsReferences: empty,
            },
          },
        }

  const json = JSON.stringify({ data })

  if (mode === "stderr-exact" || mode === "stderr-over") {
    process.stdout.write(json, () => {
      const size = mode === "stderr-exact" ? 1_048_576 : 1_048_577
      process.stderr.write("x".repeat(size), () => process.exit(0))
    })
    return
  }

  const payload =
    mode === "exact"
      ? json + " ".repeat(1_048_576 - Buffer.byteLength(json))
      : mode === "oversize"
        ? json + " ".repeat(1_048_577)
        : mode === "unicode-over"
          ? "😀".repeat(262_145)
          : json

  process.stdout.write(payload, () => process.exit(0))
})
