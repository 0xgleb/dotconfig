import assert from "node:assert/strict"
import test from "node:test"
import compactFooter from "./index.ts"

test("the mounted footer leaves one blank row below its metadata", () => {
  let start: unknown
  Reflect.apply(compactFooter, undefined, [
    {
      on: (name: string, callback: unknown) => {
        if (name === "session_start") start = callback
      },
      events: { on: () => () => {} },
    },
  ])
  assert.ok(typeof start === "function")
  start(
    {},
    {
      sessionManager: { getEntries: () => [], getCwd: () => "/project" },
      getContextUsage: () => ({ percent: 12, contextWindow: 500_000 }),
      ui: {
        setFooter: (mount: Function) => {
          const footer = mount(
            {},
            { fg: (_color: string, text: string) => text },
            {
              getGitBranch: () => "main",
              onBranchChange: () => () => {},
            },
          )
          const lines = footer.render(100)
          assert.equal(lines.length, 2)
          assert.match(lines[0], /\/project \(main\).*ctx 12\.0% of 500k/)
          assert.equal(lines[1], "")
        },
      },
    },
  )
})
