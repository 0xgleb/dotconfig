import assert from "node:assert/strict"

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  input += chunk
})
process.stdin.on("end", () => {
  const request = JSON.parse(input)
  const project = "PVT_kwHOAl_tIc4BpO1U"
  const repository = "0xgleb/dotconfig"
  const number = 179
  const issueId = `node-${repository}-${number}`
  const item = {
    id: "fixture-membership",
    isArchived: false,
    project: { id: project },
  }
  let data
  if (request.query.startsWith("query TaskProjectMembership")) {
    assert.equal(request.variables.owner, "0xgleb")
    assert.equal(request.variables.name, "dotconfig")
    assert.equal(request.variables.number, number)
    data = {
      repository: {
        nameWithOwner: repository,
        issue: {
          id: issueId,
          number,
          repository: { nameWithOwner: repository },
          projectItems: {
            nodes: process.argv[2] === "linked" ? [item] : [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }
  } else {
    assert.ok(request.query.startsWith("mutation TaskProjectPlacement"))
    assert.equal(request.variables.input.projectId, project)
    assert.equal(request.variables.input.contentId, issueId)
    data = {
      addProjectV2ItemById: {
        item: {
          ...item,
          content: {
            id: issueId,
            number,
            repository: { nameWithOwner: repository },
          },
        },
      },
    }
  }
  process.stdout.write(JSON.stringify({ data, testRequest: request }))
})
