import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Effect } from "effect";
import { BRIDGE_AGENT_TTL_MS } from "./protocol.ts";
import { remoteBridgeDatabasePath } from "./paths.ts";
import { makeRemoteBridgeStore } from "./sqlite-store.ts";

const cli = new URL("./bridge-cli.ts", import.meta.url).pathname;

const runCli = (stateRoot: string, args: readonly string[], stdin = "") =>
  spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_STATE_HOME: stateRoot },
    input: stdin,
    encoding: "utf8",
  });

test("bridge CLI exposes bounded JSON commands over exact argv and stdin", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "pi-bridge-cli-"));
  try {
    const store = makeRemoteBridgeStore(remoteBridgeDatabasePath(stateRoot, "/unused"));
    await Effect.runPromise(
      store.heartbeatAgent({
        id: "session-1",
        label: "config",
        cwd: "/work/config",
        accepting: true,
        now: Date.now(),
        ttlMs: BRIDGE_AGENT_TTL_MS,
      }),
    );

    const agents = runCli(stateRoot, ["agents"]);
    assert.equal(agents.status, 0, agents.stderr);
    const agentsJson = JSON.parse(agents.stdout) as { ok: boolean; result: Array<{ id: string }> };
    assert.equal(agentsJson.ok, true);
    assert.equal(agentsJson.result[0]?.id, "session-1");

    const registered = runCli(stateRoot, [
      "register",
      "--agent-id",
      "claude-config-receiver",
      "--label",
      "Claude - .config receiver",
      "--cwd",
      "/work/config",
    ]);
    assert.equal(registered.status, 0, registered.stderr);
    const registeredJson = JSON.parse(registered.stdout) as {
      ok: boolean;
      result: { id: string; accepting: boolean };
    };
    assert.equal(registeredJson.ok, true);
    assert.equal(registeredJson.result.id, "claude-config-receiver");
    assert.equal(registeredJson.result.accepting, true);
    const rosterAfter = runCli(stateRoot, ["agents"]);
    assert.equal(rosterAfter.status, 0, rosterAfter.stderr);
    const rosterJson = JSON.parse(rosterAfter.stdout) as {
      result: Array<{ id: string }>;
    };
    assert.ok(rosterJson.result.some((agent) => agent.id === "claude-config-receiver"));

    const sent = runCli(
      stateRoot,
      ["send", "--agent", "session-1", "--dedupe", "telegram-update-7"],
      "status please",
    );
    assert.equal(sent.status, 0, sent.stderr);
    const sentJson = JSON.parse(sent.stdout) as { ok: boolean; result: { id: string; status: string; text?: string } };
    assert.equal(sentJson.ok, true);
    assert.equal(sentJson.result.status, "queued");
    assert.equal(sentJson.result.text, undefined);

    const duplicate = runCli(
      stateRoot,
      ["send", "--agent", "session-1", "--dedupe", "telegram-update-7"],
      "different duplicate content",
    );
    const duplicateJson = JSON.parse(duplicate.stdout) as { result: { id: string } };
    assert.equal(duplicateJson.result.id, sentJson.result.id);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
