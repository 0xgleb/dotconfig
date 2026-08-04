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

test("a non-Pi lane claims and completes the messages addressed to it", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "pi-bridge-inbox-"));
  try {
    const registered = runCli(stateRoot, [
      "register",
      "--agent-id",
      "claude-config-opus-1",
      "--label",
      "Claude Code (Opus) - .config worker",
      "--cwd",
      "/work/config",
    ]);
    assert.equal(registered.status, 0, registered.stderr);

    const empty = runCli(stateRoot, ["inbox", "--agent", "claude-config-opus-1"]);
    assert.equal(empty.status, 0, empty.stderr);
    const emptyJson = JSON.parse(empty.stdout) as { result: { status: string } };
    assert.equal(emptyJson.result.status, "empty");

    const sent = runCli(
      stateRoot,
      ["send", "--agent", "claude-config-opus-1", "--dedupe", "owner-1", "--requester", "owner"],
      "please pick up issue 69",
    );
    assert.equal(sent.status, 0, sent.stderr);
    const sentJson = JSON.parse(sent.stdout) as { result: { id: string; status: string } };
    assert.equal(sentJson.result.status, "queued");

    const claimed = runCli(stateRoot, ["inbox", "--agent", "claude-config-opus-1"]);
    assert.equal(claimed.status, 0, claimed.stderr);
    const claimedJson = JSON.parse(claimed.stdout) as {
      result: { id: string; status: string; claimToken: string; text: string; requesterId: string };
    };
    assert.equal(claimedJson.result.status, "claimed");
    assert.equal(claimedJson.result.id, sentJson.result.id);
    assert.equal(claimedJson.result.text, "please pick up issue 69");
    assert.equal(claimedJson.result.requesterId, "owner");

    const drained = runCli(stateRoot, ["inbox", "--agent", "claude-config-opus-1"]);
    const drainedJson = JSON.parse(drained.stdout) as { result: { status: string } };
    assert.equal(drainedJson.result.status, "empty");

    const responded = runCli(
      stateRoot,
      ["respond", "--id", claimedJson.result.id, "--token", claimedJson.result.claimToken],
      "issue 69 inbox verb landed",
    );
    assert.equal(responded.status, 0, responded.stderr);
    const respondedJson = JSON.parse(responded.stdout) as {
      result: { status: string; response: string };
    };
    assert.equal(respondedJson.result.status, "completed");
    assert.equal(respondedJson.result.response, "issue 69 inbox verb landed");

    const result = runCli(stateRoot, ["result", "--id", claimedJson.result.id]);
    const resultJson = JSON.parse(result.stdout) as { result: { status: string } };
    assert.equal(resultJson.result.status, "completed");

    const rejected = runCli(stateRoot, ["respond", "--id", claimedJson.result.id]);
    assert.equal(rejected.status, 1);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("an asking agent withdraws its own question card once the answer arrives elsewhere", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "pi-bridge-dismiss-"));
  try {
    const registered = runCli(stateRoot, [
      "register",
      "--agent-id",
      "claude-config-opus-1",
      "--label",
      "Claude Code (Opus) - .config worker",
      "--cwd",
      "/work/config",
    ]);
    assert.equal(registered.status, 0, registered.stderr);

    const asked = runCli(
      stateRoot,
      ["ask", "--agent", "claude-config-opus-1", "--header", "Direction"],
      "which direction should I take?",
    );
    assert.equal(asked.status, 0, asked.stderr);
    const askedJson = JSON.parse(asked.stdout) as {
      result: { questionId: number };
    };

    const unparsable = runCli(stateRoot, [
      "dismiss",
      "--agent",
      "claude-config-opus-1",
      "--question",
      "not-a-number",
    ]);
    assert.equal(unparsable.status, 1);

    const dismissed = runCli(stateRoot, [
      "dismiss",
      "--agent",
      "claude-config-opus-1",
      "--question",
      String(askedJson.result.questionId),
    ]);
    assert.equal(dismissed.status, 0, dismissed.stderr);
    const dismissedJson = JSON.parse(dismissed.stdout) as {
      result: { status: string; questionId: number };
    };
    assert.equal(dismissedJson.result.status, "dismissed");
    assert.equal(dismissedJson.result.questionId, askedJson.result.questionId);

    const repeated = runCli(stateRoot, [
      "dismiss",
      "--agent",
      "claude-config-opus-1",
      "--question",
      String(askedJson.result.questionId),
    ]);
    assert.equal(repeated.status, 0, repeated.stderr);

    const foreign = runCli(stateRoot, [
      "dismiss",
      "--agent",
      "claude-st0x-opus-1",
      "--question",
      String(askedJson.result.questionId),
    ]);
    assert.equal(foreign.status, 1);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
