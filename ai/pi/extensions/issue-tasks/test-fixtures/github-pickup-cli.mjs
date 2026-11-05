import assert from "node:assert/strict"

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  input += chunk
})
process.stdin.on("end", () => {
  const request = JSON.parse(input)
  let data
  if (request.query.startsWith("query TaskPickupRead")) {
    data = {
      viewer: { id: "fixture-viewer-id", login: "0xgleb" },
      node: {
        __typename: "ProjectV2Item",
        id: request.variables.item,
        isArchived: false,
        project: {
          id: "PVT_kwHOAl_tIc4BpO1U",
          statusField: {
            __typename: "ProjectV2SingleSelectField",
            id: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
            name: "Status",
            dataType: "SINGLE_SELECT",
            options: [{ id: "47fc9ee4", name: "In progress" }],
          },
        },
        content: {
          __typename: "Issue",
          id: "fixture-issue-node-id",
          number: 7,
          state: "OPEN",
          repository: { nameWithOwner: "owner/repository" },
          assignees: {
            nodes: [{ id: "fixture-viewer-id", login: "0xgleb" }],
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        status: {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          optionId: "47fc9ee4",
          field: { id: "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs" },
        },
      },
    }
  } else if (request.query.startsWith("mutation TaskPickupAssign")) {
    assert.equal(request.variables.input.assignableId, "fixture-issue-node-id")
    assert.deepEqual(request.variables.input.assigneeIds, ["fixture-viewer-id"])
    data = {
      addAssigneesToAssignable: {
        assignable: { id: request.variables.input.assignableId },
      },
    }
  } else {
    assert.ok(request.query.startsWith("mutation TaskPickupStatus"))
    assert.equal(request.variables.input.projectId, "PVT_kwHOAl_tIc4BpO1U")
    assert.equal(
      request.variables.input.fieldId,
      "PVTSSF_lAHOAl_tIc4BpO1UzhnrYfs",
    )
    assert.deepEqual(request.variables.input.value, {
      singleSelectOptionId: "47fc9ee4",
    })
    data = {
      updateProjectV2ItemFieldValue: {
        projectV2Item: { id: request.variables.input.itemId },
      },
    }
  }
  process.stdout.write(JSON.stringify({ data }))
})
