import assert from "node:assert/strict";
import test from "node:test";
import {
  DoubleEnterSteering,
  isSlashCommandInput,
  shouldSubmitWhileWaitingForSubagent,
  type SteeringScheduler,
} from "../steering.ts";

class FakeScheduler implements SteeringScheduler {
  callback?: () => void;
  cancelled = false;

  schedule(callback: () => void) {
    this.callback = callback;
    this.cancelled = false;
    return {
      cancel: () => {
        this.cancelled = true;
        this.callback = undefined;
      },
    };
  }

  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

test("single enter submits normally after the double-enter window", () => {
  const scheduler = new FakeScheduler();
  const submitted: string[] = [];
  const immediate: string[] = [];
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    scheduler,
    onSubmit: (text) => submitted.push(text),
    onImmediate: (text) => immediate.push(text),
  });

  assert.equal(steering.handleEnter("focus the parser", true), "deferred");
  scheduler.fire();
  assert.deepEqual(submitted, ["focus the parser"]);
  assert.deepEqual(immediate, []);
});

test("second enter interrupts with exactly one immediate steering prompt", () => {
  const scheduler = new FakeScheduler();
  const submitted: string[] = [];
  const immediate: string[] = [];
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    scheduler,
    onSubmit: (text) => submitted.push(text),
    onImmediate: (text) => immediate.push(text),
  });

  assert.equal(steering.handleEnter("stop guessing and inspect it", true), "deferred");
  assert.equal(steering.handleEnter("", true), "immediate");
  scheduler.fire();
  assert.deepEqual(submitted, []);
  assert.deepEqual(immediate, ["stop guessing and inspect it"]);
  assert.equal(scheduler.cancelled, true);
});

test("double enter with an existing follow-up interrupts so the queue runs now", () => {
  const scheduler = new FakeScheduler();
  let interrupted = 0;
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    scheduler,
    onSubmit: () => assert.fail("must not submit new text"),
    onImmediate: () => assert.fail("must not duplicate queued text"),
    hasQueuedMessages: () => true,
    onQueuedImmediate: () => {
      interrupted += 1;
    },
  });

  assert.equal(steering.handleEnter("", true), "deferred");
  assert.equal(steering.handleEnter("", true), "immediate");
  scheduler.fire();
  assert.equal(interrupted, 1);
  assert.equal(scheduler.cancelled, true);
});

test("a single empty enter does not interrupt an existing follow-up queue", () => {
  const scheduler = new FakeScheduler();
  let interrupted = false;
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    scheduler,
    onSubmit: () => assert.fail("must not submit"),
    onImmediate: () => assert.fail("must not interrupt typed text"),
    hasQueuedMessages: () => true,
    onQueuedImmediate: () => {
      interrupted = true;
    },
  });

  assert.equal(steering.handleEnter("", true), "deferred");
  scheduler.fire();
  assert.equal(interrupted, false);
});

test("slash command input bypasses streaming double-enter steering", () => {
  assert.equal(isSlashCommandInput("/ques"), true);
  assert.equal(isSlashCommandInput("  /questions"), true);
  assert.equal(isSlashCommandInput("answer the question"), false);
});

test("foreground subagent waits submit human text immediately", () => {
  assert.equal(
    shouldSubmitWhileWaitingForSubagent(
      "answer the human now",
      true,
      true,
    ),
    true,
  );
  assert.equal(
    shouldSubmitWhileWaitingForSubagent("/questions", true, true),
    false,
  );
  assert.equal(
    shouldSubmitWhileWaitingForSubagent("answer the human now", true, false),
    false,
  );
  assert.equal(shouldSubmitWhileWaitingForSubagent("", true, true), false);
});

test("enter passes through while idle or without text", () => {
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    onSubmit: () => assert.fail("must not submit"),
    onImmediate: () => assert.fail("must not interrupt"),
  });
  assert.equal(steering.handleEnter("normal prompt", false), "pass");
  assert.equal(steering.handleEnter("", true), "pass");
});
