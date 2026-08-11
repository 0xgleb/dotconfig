import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  OLLAMA_ORIGIN,
  parseServedContext,
  servedContextVerdict,
  type ServedContext,
} from "./core.ts";
import { declaredContextWindow } from "./index.ts";
import { LOCAL_DISPATCH_MODEL } from "../shared/local-lane.ts";

test("the served context window is read only from what the running server names", () => {
  const running = {
    models: [
      { model: "qwen3:4b", name: "qwen3:4b", context_length: 8192 },
      { model: "qwen3.5:9b", name: "qwen3.5:9b", context_length: 40960 },
    ],
  };
  assert.deepEqual(parseServedContext("qwen3.5:9b", running), {
    served: "tokens",
    tokens: 40960,
  });
  assert.deepEqual(parseServedContext("qwen3:32b", running), {
    served: "absent",
  });
  assert.deepEqual(
    parseServedContext("qwen3.5:9b", { models: [{ name: "qwen3.5:9b" }] }),
    { served: "unreported" },
    "a running model without a reported window must never be assumed to hold the declared one",
  );
  assert.deepEqual(
    parseServedContext("qwen3.5:9b", {
      models: [{ name: "qwen3.5:9b", context_length: 0 }],
    }),
    { served: "unreported" },
  );
  assert.equal(parseServedContext("qwen3.5:9b", { models: {} }).served, "unreadable");
  assert.equal(parseServedContext("qwen3.5:9b", null).served, "unreadable");
});

test("a server serving less than the declared window is reported with its remedy", () => {
  const verdict = servedContextVerdict({
    modelId: "qwen3.5:9b",
    declared: 40960,
    stage: "session-start",
    served: { served: "tokens", tokens: 4096 },
  });
  assert.equal(verdict.verdict, "short");
  assert.match(
    verdict.verdict === "short" ? verdict.notice : "",
    /4096.*40960.*OLLAMA_CONTEXT_LENGTH=40960/su,
  );
  assert.deepEqual(
    servedContextVerdict({
      modelId: "qwen3.5:9b",
      declared: 40960,
      stage: "after-turn",
      served: { served: "tokens", tokens: 40960 },
    }),
    { verdict: "sufficient" },
  );
});

test("an unloaded model is retried at session start and reported once a turn has run", () => {
  const unverifiable: readonly ServedContext[] = [
    { served: "absent" },
    { served: "unreported" },
    { served: "unreadable", detail: "the local Ollama server did not answer" },
  ];
  for (const served of unverifiable) {
    assert.deepEqual(
      servedContextVerdict({
        modelId: "qwen3.5:9b",
        declared: 40960,
        stage: "session-start",
        served,
      }),
      { verdict: "retry" },
      "a model is loaded on demand, so a cold start is not yet evidence of anything",
    );
    const settled = servedContextVerdict({
      modelId: "qwen3.5:9b",
      declared: 40960,
      stage: "after-turn",
      served,
    });
    assert.equal(settled.verdict, "unverified");
    assert.match(
      settled.verdict === "unverified" ? settled.notice : "",
      /40960/u,
    );
  }
  const unreachable = servedContextVerdict({
    modelId: "qwen3.5:9b",
    declared: 40960,
    stage: "after-turn",
    served: {
      served: "unreadable",
      detail: "the local Ollama server did not answer",
    },
  });
  assert.match(
    unreachable.verdict === "unverified" ? unreachable.notice : "",
    /did not answer/u,
    "the reason the window could not be verified belongs in the notice",
  );
});

test("the provider and the launcher's readiness probe address the same loopback", () => {
  assert.equal(OLLAMA_ORIGIN, "http://127.0.0.1:11434");
});

test("a window the server never named is reported as unread, not as a short server", () => {
  const unreported = servedContextVerdict({
    modelId: LOCAL_DISPATCH_MODEL,
    declared: 40960,
    stage: "after-turn",
    served: { served: "unreported" },
  });
  assert.equal(unreported.verdict, "unverified");
  const notice = unreported.verdict === "unverified" ? unreported.notice : "";
  assert.match(
    notice,
    /not evidence the served window is short/u,
    "an Ollama build that names no context length must not be read as a short server",
  );
  assert.doesNotMatch(
    notice,
    /is served with/u,
    "an unread window is never restated as a size the server reported",
  );
  assert.match(notice, /OLLAMA_CONTEXT_LENGTH=40960/u);
});

test("the model tag the launcher pins is the model tag this registration declares", () => {
  const routing = readFileSync(
    new URL("../../../../nushell/fj/routing.nu", import.meta.url),
    "utf8",
  );
  const launcherModel = /export const dispatch_model = "([^"]+)"/u.exec(
    routing,
  )?.[1];
  assert.equal(
    launcherModel,
    LOCAL_DISPATCH_MODEL,
    "the launcher builds --model ollama/<tag> from routing.nu, so a tag this registration does not declare runs the lane on a model it never described",
  );
  const declared = declaredContextWindow(LOCAL_DISPATCH_MODEL);
  assert.ok(
    typeof declared === "number" && declared > 0,
    "an undeclared tag makes the served-context check return before it probes anything, removing the only guard against silent server-side truncation",
  );
});
