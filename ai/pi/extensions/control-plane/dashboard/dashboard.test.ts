import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8")
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8")
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
  assert.doesNotMatch(app, /innerHTML|dangerouslySetInnerHTML/)
})

test("dashboard remains observational until typed control commands exist", () => {
  assert.match(app, /VIEW ONLY/)
  assert.match(app, /Browser controls remain disabled/)
  assert.doesNotMatch(app, /\/cancel|\/retry|method:\s*"(?:DELETE|PATCH|PUT)"/)
})

test("the Nix bundle stages the full local import graph beside node modules", () => {
  assert.match(homeConfig, /cp .*job-runtime\.ts.*src\/job-runtime\.ts/)
  assert.match(homeConfig, /ln -s .*node_modules.*src\/node_modules/)
  assert.match(homeConfig, /node_modules\/\.bin\/babel dashboard\/app\.tsx/)
  assert.match(homeConfig, /--presets=@babel\/preset-typescript,babel-preset-solid/)
  assert.match(homeConfig, /esbuild dashboard\/app\.js/)
})

test("dashboard assets are local, responsive, and preserve a dark cyan theme", () => {
  assert.match(html, /id="root"/)
  assert.match(html, /src="\/app\.js"/)
  assert.match(html, /href="\/app\.css"/)
  assert.doesNotMatch(`${html}\n${css}\n${app}`, /https?:\/\//)
  assert.match(css, /--cyan:\s*#42d9e6/)
  assert.match(css, /#07111f/)
  assert.match(css, /@media \(max-width: 660px\)/)
  assert.match(css, /prefers-reduced-motion/)
})
