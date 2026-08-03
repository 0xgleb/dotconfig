import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/questions/index.ts", import.meta.url), "utf8");

test("ask_user publishes its typed parameters on the registered tool definition", () => {
  assert.doesNotMatch(source, /description:[\s\S]{0,240}\}\s*,\s*\{\s*promptSnippet:/);
  assert.match(
    source,
    /pi\.registerTool\(\{[\s\S]*?name: "ask_user"[\s\S]*?parameters: Type\.Object\(\{[\s\S]*?action: Type\.Union/,
  );
});
