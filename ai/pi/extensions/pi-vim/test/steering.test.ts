import assert from "node:assert/strict";
import test from "node:test";
import { DoubleEnterSteering, type SteeringScheduler } from "../steering.ts";

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

test("enter passes through while idle or without text", () => {
  const steering = new DoubleEnterSteering({
    windowMs: 350,
    onSubmit: () => assert.fail("must not submit"),
    onImmediate: () => assert.fail("must not interrupt"),
  });
  assert.equal(steering.handleEnter("normal prompt", false), "pass");
  assert.equal(steering.handleEnter("", true), "pass");
});
