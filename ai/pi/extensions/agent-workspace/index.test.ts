import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("dedicated workspace launch is profile-bound and shell-free", () => {
  assert.match(source, /name: "agent_workspace"/);
  assert.match(
    source,
    /StringEnum\(\s*\["st0x-review", "dataclique-review", "personal-review"\]/,
  );
  assert.match(
    source,
    /pi\.exec\("zellij", \[\.\.\.zellijLaunchArguments\(profile\)\]/,
  );
  assert.doesNotMatch(source, /pi\.exec\("(?:bash|sh|zsh)"/);
  assert.match(source, /query-tab-names/);
  assert.match(source, /existing \? "running" : "stopped"/);
});
