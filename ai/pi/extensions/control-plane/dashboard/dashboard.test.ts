import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const appUrl = new URL("./app.tsx", import.meta.url)
const app = readFileSync(appUrl, "utf8")
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

const localSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(/from "(\.[^"]+)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )

/** Every local module the bundle entry reaches, keyed by file URL. */
const localImportGraph = (
  entry: URL,
  collected: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> => {
  if (collected.has(entry.href)) return collected
  const source = readFileSync(entry, "utf8")
  return localSpecifiers(source).reduce<ReadonlyMap<string, string>>(
    (graph, specifier) => localImportGraph(new URL(specifier, entry), graph),
    new Map(collected).set(entry.href, source),
  )
}

const literal = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

test("the Nix bundle stages the full local import graph beside node modules", () => {
  const graph = localImportGraph(appUrl, new Map())
  const imported = [...graph.keys()].filter((href) => href !== appUrl.href)
  assert.ok(imported.length > 0, "app.tsx must reach at least one local module")
  assert.match(
    homeConfig,
    /cp \$\{[^}]*\/dashboard\/app\.tsx\} src\/dashboard\/app\.tsx/u,
  )
  for (const href of imported) {
    const name = literal(href.slice(href.lastIndexOf("/") + 1))
    assert.match(
      homeConfig,
      new RegExp(`cp \\$\\{[^}]*/${name}\\} src/${name}`, "u"),
    )
  }
  for (const [href, source] of graph)
    assert.doesNotMatch(source, /from "node:/u, `${href} imports a Node builtin`)
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
