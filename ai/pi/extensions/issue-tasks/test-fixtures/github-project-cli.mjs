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

  const request = JSON.parse(input)
  const personal = request.variables.project === "PVT_kwHOAl_tIc4BpO1U"
  const field = (id, name, backing) => ({
    __typename: "ProjectV2Field",
    id,
    name,
    dataType: "NUMBER",
    isIssueField: backing !== null,
    issueField:
      backing === null ? null : { __typename: "IssueFieldNumber", id: backing },
  })
  const number = (id, value) =>
    personal
      ? {
          __typename: "ProjectV2ItemFieldNumberValue",
          field: { id },
          number: value,
        }
      : {
          __typename: "ProjectV2ItemIssueFieldValue",
          field: { id },
          issueFieldValue: { __typename: "IssueFieldNumberValue", value },
        }
  const priority = personal
    ? "PVTF_lAHOAl_tIc4BpO1UzhnrZvE"
    : "PVTF_lADOCA_DB84BkDqIzhnrbUw"
  const effort = personal
    ? "PVTF_lAHOAl_tIc4BpO1UzhnrY5k"
    : "PVTF_lADOCA_DB84BkDqIzhny3PM"

  process.stdout.write(
    JSON.stringify({
      data: {
        node: {
          __typename: "ProjectV2",
          id: request.variables.project,
          number: personal ? 4 : 12,
          owner: personal
            ? { __typename: "User", login: "0xgleb" }
            : { __typename: "Organization", login: "dataclique" },
          priorityField: field(
            priority,
            "Priority",
            personal ? null : "IFN_kgDOAu5Mmg",
          ),
          effortField: field(
            effort,
            "Effort",
            personal ? null : "IFN_kgDOAu7REw",
          ),
          items: {
            nodes: [
              {
                id: JSON.stringify(request),
                isArchived: false,
                content: {
                  __typename: "Issue",
                  number: 7,
                  state: "OPEN",
                  repository: { nameWithOwner: "owner/repository" },
                },
                priority: number(priority, 2),
                effort: number(effort, 5),
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
    () => process.exit(0),
  )
})
