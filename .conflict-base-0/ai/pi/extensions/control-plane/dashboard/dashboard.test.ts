import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8")
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
const browserRuntimeSources = [
  "../job-runtime.ts",
  "../job-presentation.ts",
  "../harness-protocol.ts",
  "../harness-research-protocol.ts",
  "../review-duty-profile.ts",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8"))
const homeConfig = readFileSync(
  new URL("../../../../../home.nix", import.meta.url),
  "utf8",
)

test("dashboard uses Solid lifecycle primitives and validates API job state", () => {
  assert.match(app, /from "solid-js"/)
  assert.match(app, /createMemo/)
  assert.match(app, /createResource\(fetchSnapshot\)/)
  assert.match(app, /onMount/)
  assert.match(app, /onCleanup\(\(\) => clearInterval\(timer\)\)/)
  assert.match(app, /decodeStoredJob/)
  assert.match(app, /fetchJson\("\/v1\/agents"\)/)
  assert.match(app, /strong>\{onlineAgents\(\)\.length\}<\/strong>/)
  assert.match(app, /bridge-endpoint/)
  assert.match(
    app,
    /presence !== "bridge-endpoint" &&[\s\S]*?roles\.length > 0 \|\|[\s\S]*?status !== "pending"/,
  )
  assert.match(app, /inactive\s+or unverified sessions excluded/)
  assert.match(
    app,
    /unassigned runtimes and[\s\S]*?monitor-only bridge endpoints[\s\S]*?excluded from the live-agent total/,
  )
  assert.match(app, /agent\.activities/)
  assert.match(app, /external harness/)
  assert.match(app, /#\{activity\.todoId\} \{activity\.text\}/)
  assert.match(app, /SUBSCRIPTION RUNWAY/)
  assert.match(app, /allowanceRunway/)
  assert.match(app, /usagePolicy/)
  assert.match(app, /autonomous budget/)
  assert.match(app, /observed ·/)
  assert.match(app, /allowanceTargetPolyline/)
  assert.match(app, /allowanceChartDomain/)
  assert.match(app, /allowanceChartSegments/)
  assert.match(app, /allowanceChartX/)
  assert.match(app, /reconstructChatGptSharedHistory/)
  assert.match(app, /usageHistory\(\)\?\.control\.pool/)
  assert.match(app, /activeCheckpoints/)
  assert.match(app, /selectedAllowanceCheckpoints/)
  assert.match(app, /decodeThrottleActivity/)
  assert.match(app, /provider roles throttled/)
  assert.match(app, /codexAllowancePolylines/)
  assert.match(app, /allowance-line codex/)
  assert.match(app, /allowance-point codex observed/)
  assert.match(app, /Allowance chart methodology/)
  assert.match(app, /pools are never merged/)
  assert.match(app, /allowance bump rebased/)
  assert.match(app, /ChatGPT shared weekly/)
  assert.match(app, /Codex app-server weekly/)
  assert.match(app, /Historical samples only/)
  assert.match(
    app,
    /Last verified \$\{relativeTime\(checkpoint\.capturedAt, now\)\}/,
  )
  assert.match(app, /MAX_ALLOWANCE_CHECKPOINT_AGE_MS/)
  assert.doesNotMatch(
    app,
    /inferredAllowanceBailouts|Recorded allowance increase|Bailout \+/,
  )
  assert.match(app, /Reset 100 · est\./)
  assert.match(app, /Zero · est\./)
  assert.match(app, /Bailout 100 · reported/)
  assert.match(app, /allowanceEventDetail/)
  assert.match(app, /<line\s+class=\{`allowance-event/)
  assert.match(app, /<ellipse/)
  assert.doesNotMatch(app, /<circle\s+class=\{`allowance-point/)
  assert.doesNotMatch(
    app,
    /\.filter\(\(\{ resetAt \}\) => resetAt === activeRunway\.latest\.resetAt\)/,
  )
  assert.match(app, /PROJECT ALLOCATION/)
  assert.doesNotMatch(app, /FEEDER LANES|agentops-(?:config|yielduck|review)/)
  assert.match(app, /job\.spec\.payload\.task/)
  assert.match(app, /jobSchedulePresentation\(job\)/)
  assert.match(app, /classList=\{\{ stale: schedule\.stale \}\}/)
  assert.doesNotMatch(app, /job\.state === "leased" \? "Lease" : "Run"/)
  assert.match(app, /Array\.isArray\(value\.checkpoints\)/)
  assert.doesNotMatch(app, /innerHTML|dangerouslySetInnerHTML/)
})

test("dashboard browser bundle dependencies do not import Node built-ins", () => {
  assert.doesNotMatch(
    [app, ...browserRuntimeSources].join("\n"),
    /(?:from|import\()\s*["']node:/,
  )
})

test("dashboard remains observational until typed control commands exist", () => {
  assert.match(app, /VIEW ONLY/)
  assert.match(app, /Browser controls remain disabled/)
  assert.doesNotMatch(app, /\/cancel|\/retry|method:\s*"(?:DELETE|PATCH|PUT)"/)
})

test("the managed runtime rebuilds and watches dashboard assets from the live source tree", () => {
  assert.match(homeConfig, /piControlPlane = pkgs\.writeTextFile/)
  assert.match(homeConfig, /cp .*allowance-chart\.ts/)
  assert.match(homeConfig, /cp .*allowance-pool\.ts/)
  assert.match(homeConfig, /cp .*job-runtime\.ts/)
  assert.match(homeConfig, /cp .*job-presentation\.ts/)
  assert.match(homeConfig, /cp .*harness-research-protocol\.ts/)
  assert.match(homeConfig, /cp .*usage-policy\.ts/)
  assert.match(homeConfig, /dashboard-build-\(\$nu\.pid\)/)
  assert.doesNotMatch(homeConfig, /cd \$build_root/)
  assert.match(homeConfig, /rm --recursive --force \$build_root/)
  const staleNodeModulesCleanup = homeConfig.indexOf(
    'rm --recursive --force ($build_root | path join "node_modules")',
  )
  const nodeModulesLink = homeConfig.indexOf(
    "ln --symbolic --no-target-directory",
  )
  assert.ok(staleNodeModulesCleanup >= 0)
  assert.ok(nodeModulesLink > staleNodeModulesCleanup)
  assert.match(homeConfig, /node_modules\/\.bin\/babel/)
  assert.match(
    homeConfig,
    /--presets=\$\{piExtensionNodeModules\}\/node_modules\/@babel\/preset-typescript,\$\{piExtensionNodeModules\}\/node_modules\/babel-preset-solid/,
  )
  assert.match(homeConfig, /lib\.getExe pkgs\.esbuild/)
  assert.match(homeConfig, /exec \$\{lib\.getExe pkgs\.watchexec\}/)
  assert.match(homeConfig, /--exit-on-error/)
  assert.match(homeConfig, /--shell=none/)
  assert.match(homeConfig, /-- \$\{piControlPlane\}\/bin\/pi-control-plane/)
})

test("dashboard assets are local, responsive, and share the terminal archeofuturism palette", () => {
  assert.match(html, /id="root"/)
  assert.match(html, /src="\/app\.js"/)
  assert.match(html, /href="\/app\.css"/)
  assert.doesNotMatch(`${html}\n${css}\n${app}`, /https?:\/\//)
  assert.match(css, /--cyan:\s*#29e7ff/i)
  assert.match(css, /--magenta:\s*#ff4fd8/i)
  assert.match(css, /--violet:\s*#983c8d/i)
  assert.match(css, /background:\s*#000000/)
  assert.match(css, /\.allowance-card\.stale/)
  assert.match(css, /\.allowance-point\.estimated/)
  assert.match(css, /\.allowance-point\.event/)
  assert.match(css, /\.allowance-event\.estimated/)
  assert.match(css, /\.throttle-note/)
  assert.match(css, /\.throttle-note\.active/)
  assert.match(css, /\.job-schedule\.stale strong/)
  assert.doesNotMatch(css, /\.allowance-card\.stale svg\s*\{[^}]*opacity:/s)
  assert.doesNotMatch(css, /#07111f|#0f1f31|#102236/i)
  assert.match(css, /@media \(max-width: 660px\)/)
  assert.match(css, /prefers-reduced-motion/)
})
