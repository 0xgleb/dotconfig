import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPATCH_LANE_ENVIRONMENT,
  LOCAL_DISPATCH_LANE,
  dispatchLane,
  isLocalDispatchProvider,
} from "./local-lane.ts";

const declared = { [DISPATCH_LANE_ENVIRONMENT]: LOCAL_DISPATCH_LANE };

test("a session the launcher did not pin is never the dispatch lane", () => {
  assert.deepEqual(dispatchLane("ollama", {}), { lane: "standard" });
  assert.deepEqual(dispatchLane("ollama", { [DISPATCH_LANE_ENVIRONMENT]: "" }), {
    lane: "standard",
  });
  assert.deepEqual(
    dispatchLane("anthropic", { [DISPATCH_LANE_ENVIRONMENT]: "dispatcher" }),
    { lane: "standard" },
    "only the declared lane value names the dispatch lane",
  );
});

test("the launcher's declaration is what makes a session the dispatch lane", () => {
  assert.deepEqual(dispatchLane("ollama", declared), {
    lane: "local-dispatch",
    declaration: "consistent",
  });
  assert.deepEqual(
    dispatchLane("ollama", {
      [DISPATCH_LANE_ENVIRONMENT]: ` ${LOCAL_DISPATCH_LANE} `,
    }),
    { lane: "local-dispatch", declaration: "consistent" },
  );
});

test("a declared lane keeps its bounds when the session switches model", () => {
  assert.deepEqual(dispatchLane("anthropic", declared), {
    lane: "local-dispatch",
    declaration: "unexpected-provider",
  });
  assert.deepEqual(dispatchLane(undefined, declared), {
    lane: "local-dispatch",
    declaration: "unexpected-provider",
  });
});

test("the lane predicate reads the launcher's declaration from the environment", () => {
  const previous = process.env[DISPATCH_LANE_ENVIRONMENT];
  try {
    delete process.env[DISPATCH_LANE_ENVIRONMENT];
    assert.equal(
      isLocalDispatchProvider("ollama"),
      false,
      "an undeclared local model must keep its tools, prompt, and registry role",
    );
    process.env[DISPATCH_LANE_ENVIRONMENT] = LOCAL_DISPATCH_LANE;
    assert.equal(isLocalDispatchProvider("ollama"), true);
    assert.equal(isLocalDispatchProvider("anthropic"), true);
  } finally {
    if (previous === undefined) delete process.env[DISPATCH_LANE_ENVIRONMENT];
    else process.env[DISPATCH_LANE_ENVIRONMENT] = previous;
  }
});
