import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const skillsRoot = new URL("../skills/", import.meta.url)
const piDocs = readFileSync(
  "/nix/store/dgj5jv12whj670i345i69h77i895vdwa-pi-coding-agent-0.84.1/lib/node_modules/pi-monorepo/README.md",
  "utf8",
)
const piInstructions = readFileSync(
  new URL("../pi/AGENTS.md", import.meta.url),
  "utf8",
)
const newSkill = readFileSync(
  new URL("../skills/new-skill/SKILL.md", import.meta.url),
  "utf8",
)
const handoverSkill = readFileSync(
  new URL("../skills/handover/SKILL.md", import.meta.url),
  "utf8",
)
const registerSkill = readFileSync(
  new URL("../skills/register/SKILL.md", import.meta.url),
  "utf8",
)

const skillFiles = readdirSync(skillsRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(skillsRoot.pathname, entry.name, "SKILL.md"))
  .filter(path => {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  })

const frontmatter = (source: string): string =>
  source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""

test("Pi documentation and the EOD skill agree on the available discovery contract", () => {
  assert.match(
    piDocs,
    /Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`/,
  )
  const eodPath = skillFiles.find(path => path.endsWith("/eod/SKILL.md"))
  assert.ok(eodPath)
  assert.doesNotMatch(
    frontmatter(readFileSync(eodPath, "utf8")),
    /(?:^|[,\s])Glob(?:[,\s]|$)/m,
  )
})

test("Pi instructions require capability checks and semantics-preserving equivalents", () => {
  assert.match(
    piInstructions,
    /Before following a skill's named tool procedure, verify that tool exists/i,
  )
  assert.match(piInstructions, /use an available semantically equivalent tool/i)
  assert.match(
    piInstructions,
    /preserv(?:e|ing) the\s+original scope, exclusions, and mutation boundary/i,
  )
  assert.match(
    piInstructions,
    /never stop merely because a\s+shared skill names another harness's tool/i,
  )
})

test("new shared skills must document tested Pi equivalents for harness-specific tools", () => {
  assert.match(newSkill, /allowed-tools.*does not create tools/is)
  assert.match(newSkill, /document the exact Pi tool or bounded equivalent/i)
  assert.match(newSkill, /tested semantics-preserving equivalent/i)
  assert.match(
    newSkill,
    /rather than instructing the agent to\s+stop or ask for a nonexistent tool/is,
  )
})

test("register cadence uses loop syntax order instead of silently falling back to one hour", () => {
  assert.match(registerSkill, /loop_control \{ args: "30m \/register" \}/)
  assert.match(registerSkill, /Never pass\s+`args: "\/register 30m"`/is)
  assert.match(
    registerSkill,
    /Verify the returned interval\s+equals the requested cadence/is,
  )
})

test("handover is a terminal artifact-producing procedure with truthful partial-state fallback", () => {
  assert.match(handoverSkill, /terminal stop boundary/i)
  assert.match(
    handoverSkill,
    /immediately stop\s+coding, reviewing, merging, publishing, testing, cleanup/is,
  )
  assert.match(handoverSkill, /record the\s+missing field as `unverified`/is)
  assert.match(handoverSkill, /do not inspect unrelated repositories/i)
  assert.match(handoverSkill, /do not silently degrade to an inline summary/i)
  assert.match(
    handoverSkill,
    /single-repository session.*current project-role workspace/is,
  )
  assert.match(handoverSkill, /yielduck.*yielduck\/\.tmp\/handoffs/is)
  assert.doesNotMatch(handoverSkill, /outside every Git repository/i)
  assert.match(
    piInstructions,
    /single-repository session.*current project-role workspace's `\.tmp\/handoffs\/`/is,
  )
  assert.match(
    handoverSkill,
    /verify that the exact file exists and is readable/i,
  )
  assert.match(handoverSkill, /end the turn after\s+this report/is)
})
