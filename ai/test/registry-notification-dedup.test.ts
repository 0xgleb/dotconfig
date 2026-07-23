import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../pi/extensions/agent-registry/index.ts", import.meta.url), "utf8");

test("registry request notifications survive reload and compaction", () => {
  assert.match(source, /NOTIFIED_REQUESTS_ENTRY = "agent-registry\.notified-requests"/);
  assert.match(source, /restoreNotifiedRequests\(ctx\)/);
  assert.match(source, /notifiedRequests\.add\(request\.id\);\s*persistNotifiedRequests\(\)/);
  assert.match(source, /pi\.on\("session_compact", \(\) => persistNotifiedRequests\(\)\)/);
});
