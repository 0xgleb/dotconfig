import { loadBoundedSessionEntriesSync } from "../../pi/host/bounded-session-reader.js"

const filePath = process.argv[2]
if (!filePath) throw new Error("session file path is required")

const entries = loadBoundedSessionEntriesSync(filePath)
const firstEntry = entries[0]
const secondEntry = entries[1]
const thirdEntry = entries[2]
const lastEntry = entries.at(-1)

process.stdout.write(
  JSON.stringify({
    count: entries.length,
    firstType:
      typeof firstEntry === "object" &&
      firstEntry !== null &&
      "type" in firstEntry &&
      typeof firstEntry.type === "string"
        ? firstEntry.type
        : null,
    secondCustomType:
      typeof secondEntry === "object" &&
      secondEntry !== null &&
      "customType" in secondEntry &&
      typeof secondEntry.customType === "string"
        ? secondEntry.customType
        : null,
    secondId:
      typeof secondEntry === "object" &&
      secondEntry !== null &&
      "id" in secondEntry &&
      typeof secondEntry.id === "string"
        ? secondEntry.id
        : null,
    thirdParentId:
      typeof thirdEntry === "object" &&
      thirdEntry !== null &&
      "parentId" in thirdEntry &&
      typeof thirdEntry.parentId === "string"
        ? thirdEntry.parentId
        : null,
    lastId:
      typeof lastEntry === "object" &&
      lastEntry !== null &&
      "id" in lastEntry &&
      typeof lastEntry.id === "string"
        ? lastEntry.id
        : null,
  }),
)
