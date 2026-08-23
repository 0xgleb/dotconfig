import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const skillUrl = (name: string) =>
  new URL(`../skills/${name}/SKILL.md`, import.meta.url)
const readSkill = (name: string): string => readFileSync(skillUrl(name), "utf8")

const approvedSkills = [
  "defensive-programming-inspector",
  "architecture-direction-inspector",
  "quantitative-research-inspector",
] as const

const reviewCore = readSkill("review-core")
const financial = readSkill("financial-programming-inspector")
const trading = readSkill("quantitative-trading-inspector")
const risk = readSkill("risk-management-inspector")

test("approved higher-level inspector skills exist", () => {
  for (const name of approvedSkills)
    assert.equal(existsSync(skillUrl(name)), true, `${name} must exist`)
})

test("defensive inspector reconstructs deterministic system invariants", () => {
  const inspector = readSkill("defensive-programming-inspector")
  assert.match(inspector, /canonical source/i)
  assert.match(inspector, /conservation|reconciliation/i)
  assert.match(inspector, /cross-view/i)
  assert.match(inspector, /valuation (basis|timestamp)/i)
  assert.match(inspector, /deposits[\s\S]*withdrawals[\s\S]*(returns|equity)/i)
  assert.match(inspector, /whole-book[\s\S]*positions[\s\S]*(NAV|performance)/i)
})

test("architecture inspector gates dependency recommendations on project evidence", () => {
  const inspector = readSkill("architecture-direction-inspector")
  assert.match(inspector, /evidence hierarchy/i)
  assert.match(inspector, /dependency recommendation bar/i)
  assert.match(inspector, /migration[\s\S]*rollback/i)
  assert.match(inspector, /newer, popular, or personally preferred/i)
  assert.match(inspector, /project direction/i)
})

test("quantitative research inspector requires falsification and robustness", () => {
  const inspector = readSkill("quantitative-research-inspector")
  assert.match(inspector, /falsifiable hypothesis/i)
  assert.match(inspector, /multiple testing|repeated search/i)
  assert.match(inspector, /regime|structural break/i)
  assert.match(inspector, /subscription-credit|resource model/i)
  assert.match(inspector, /portfolio|allocation/i)
})

test("existing financial, trading, and risk inspectors cover complementary higher-level concerns", () => {
  assert.match(financial, /accounting identit/i)
  assert.match(financial, /cross-(ledger|view) reconciliation/i)
  assert.match(trading, /strategy premise|research evidence/i)
  assert.match(trading, /quantitative-research inspector/i)
  assert.match(risk, /aggregate exposure/i)
  assert.match(risk, /concentration/i)
  assert.match(risk, /stress|scenario/i)
  assert.match(risk, /model uncertainty/i)
})

test("review core selects and preserves the new higher-level lanes", () => {
  for (const name of approvedSkills) assert.match(reviewCore, new RegExp(name))
  for (const category of ["architecture", "financial", "strategy", "risk"])
    assert.match(reviewCore, new RegExp(`['\\\"]${category}['\\\"]`))
  assert.match(reviewCore, /stateful[\s\S]*reconciliation/i)
  assert.match(reviewCore, /dependency[\s\S]*architecture-direction/i)
  assert.match(reviewCore, /forecast[\s\S]*quantitative-research/i)
  assert.match(reviewCore, /architectural[\s\S]*strategic findings/i)
})
