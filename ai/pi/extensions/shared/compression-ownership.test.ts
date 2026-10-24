import assert from "node:assert/strict"
import test from "node:test"
import {
  createEventBus,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Effect, Either } from "effect"
import {
  getAutomaticCompressionOwner,
  registerAutomaticCompressionOwner,
  type AutomaticCompressionOwner,
  type CompressionOwnershipError,
} from "./compression-ownership.ts"

const deferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>(accept => {
    resolve = accept
  })
  if (!resolve) throw new Error("Deferred test fixture was not initialized")
  return { promise, resolve }
}

const fixture = () => {
  let sessionId = "session-a"
  const pi = { events: createEventBus() }
  const context = {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext
  const read = (signal = new AbortController().signal) =>
    Effect.runPromise(
      Effect.either(getAutomaticCompressionOwner(pi, context, signal)),
    )
  return {
    pi,
    context,
    read,
    replaceSession: (next = "session-b") => {
      sessionId = next
    },
  }
}

const expectError = (
  result: Either.Either<AutomaticCompressionOwner, CompressionOwnershipError>,
  code: CompressionOwnershipError["code"],
) => {
  if (Either.isRight(result))
    return assert.fail("Expected a typed ownership failure")
  assert.equal(result.left._tag, "CompressionOwnershipError")
  assert.equal(result.left.code, code)
}

test("no registered compressor preserves native ownership through the real SDK event bus", async () => {
  const f = fixture()
  assert.deepEqual(await f.read(), Either.right({ owner: "native" }))
})

test("an exact-session registered compressor supplies one ownership decision", async () => {
  const f = fixture()
  const stop = registerAutomaticCompressionOwner(
    f.pi,
    async (context, signal) => {
      assert.equal(context, f.context)
      assert.equal(signal.aborted, false)
      return {
        owner: "billion-context",
        sessionId: context.sessionManager.getSessionId(),
      }
    },
  )
  assert.deepEqual(
    await f.read(),
    Either.right({ owner: "billion-context", sessionId: "session-a" }),
  )
  stop()
  assert.deepEqual(await f.read(), Either.right({ owner: "native" }))
})

test("an installed controller may explicitly leave this session native", async () => {
  const f = fixture()
  registerAutomaticCompressionOwner(f.pi, async () => ({ owner: "native" }))
  assert.deepEqual(await f.read(), Either.right({ owner: "native" }))
})

test("competing controllers are rejected before either can run", async () => {
  const f = fixture()
  let calls = 0
  for (let i = 0; i < 2; i++)
    registerAutomaticCompressionOwner(f.pi, async () => {
      calls++
      return { owner: "billion-context", sessionId: "session-a" }
    })
  expectError(await f.read(), "conflicting")
  assert.equal(calls, 0)
})

test("a claim for a foreign session cannot suppress this session's native safety", async () => {
  const f = fixture()
  registerAutomaticCompressionOwner(f.pi, async () => ({
    owner: "billion-context",
    sessionId: "session-other",
  }))
  expectError(await f.read(), "stale-session")
})

test("session replacement while the controller is pending invalidates its reply", async () => {
  const f = fixture()
  const reply = deferred<AutomaticCompressionOwner>()
  const entered = deferred<void>()
  registerAutomaticCompressionOwner(f.pi, async () => {
    entered.resolve()
    return reply.promise
  })
  const pending = f.read()
  const first = await Promise.race([
    entered.promise.then(() => "entered"),
    pending.then(() => "completed-before-controller"),
  ])
  assert.equal(
    first,
    "entered",
    "Ownership must be resolved through the registered controller",
  )
  f.replaceSession()
  reply.resolve({ owner: "billion-context", sessionId: "session-a" })
  expectError(await pending, "stale-session")
})

for (const value of [
  null,
  true,
  {},
  { owner: "future-compressor" },
  { owner: "billion-context" },
  { owner: "native", sessionId: "session-other" },
]) {
  test(`malformed external controller reply stays a typed failure: ${JSON.stringify(value)}`, async () => {
    const f = fixture()
    f.pi.events.on(
      "pi:automatic-compression-ownership.v1",
      (query: unknown) => {
        if (
          !query ||
          typeof query !== "object" ||
          !("accept" in query) ||
          typeof query.accept !== "function"
        )
          throw new Error("Expected the real ownership query callback")
        query.accept(async () => value)
      },
    )
    expectError(await f.read(), "malformed")
  })
}

test("a rejected external controller is unavailable, never an implicit managed claim", async () => {
  const f = fixture()
  registerAutomaticCompressionOwner(f.pi, () =>
    Promise.reject(new Error("fixture unavailable")),
  )
  expectError(await f.read(), "unavailable")
})

test(
  "an unresponsive controller has a bounded typed failure",
  { timeout: 3000 },
  async () => {
    const f = fixture()
    registerAutomaticCompressionOwner(f.pi, () => new Promise(() => {}))
    const result = await f.read()
    expectError(result, "unavailable")
    if (Either.isLeft(result))
      assert.match(result.left.message, /did not respond/iu)
    else assert.fail("Expected a bounded ownership failure")
  },
)

test("controller rejection after request cancellation stays cancelled", async () => {
  const f = fixture()
  const controller = new AbortController()
  const entered = deferred<void>()
  registerAutomaticCompressionOwner(
    f.pi,
    (_context, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("fixture cancelled")),
          { once: true },
        )
        entered.resolve()
      }),
  )
  const pending = f.read(controller.signal)
  await entered.promise
  controller.abort()
  expectError(await pending, "cancelled")
})

test("an accessor-bearing external claim is rejected without evaluating its getter", async () => {
  const f = fixture()
  let evaluated = false
  const reply = Object.defineProperty({}, "owner", {
    enumerable: true,
    get: () => {
      evaluated = true
      throw new Error("fixture getter must not run")
    },
  })
  f.pi.events.on("pi:automatic-compression-ownership.v1", (query: unknown) => {
    if (
      !query ||
      typeof query !== "object" ||
      !("accept" in query) ||
      typeof query.accept !== "function"
    )
      throw new Error("Expected the real ownership query callback")
    query.accept(async () => reply)
  })
  expectError(await f.read(), "malformed")
  assert.equal(evaluated, false)
})

test("request cancellation does not wait for a resolver that ignores its signal", async () => {
  const f = fixture()
  const controller = new AbortController()
  const entered = deferred<void>()
  registerAutomaticCompressionOwner(
    f.pi,
    () =>
      new Promise(() => {
        entered.resolve()
      }),
  )
  const pending = f.read(controller.signal)
  await entered.promise
  const started = performance.now()
  controller.abort()
  expectError(await pending, "cancelled")
  assert.ok(
    performance.now() - started < 500,
    "Cancellation must not wait for the one-second ownership timeout",
  )
})

test("non-callable offers are malformed and synchronous resolver failures are typed", async () => {
  const f = fixture()
  const stop = f.pi.events.on(
    "pi:automatic-compression-ownership.v1",
    (query: unknown) => {
      if (
        !query ||
        typeof query !== "object" ||
        !("accept" in query) ||
        typeof query.accept !== "function"
      )
        throw new Error("Expected the real ownership query callback")
      query.accept(false)
    },
  )
  expectError(await f.read(), "malformed")
  stop()
  registerAutomaticCompressionOwner(f.pi, () => {
    throw new Error("fixture synchronous failure")
  })
  expectError(await f.read(), "unavailable")
})

test("descriptor traps and extra symbol fields cannot escape exact-shape validation", async () => {
  for (const reply of [
    new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("fixture descriptor trap")
        },
      },
    ),
    { owner: "native", [Symbol("extra")]: true },
  ]) {
    const f = fixture()
    f.pi.events.on(
      "pi:automatic-compression-ownership.v1",
      (query: unknown) => {
        if (
          !query ||
          typeof query !== "object" ||
          !("accept" in query) ||
          typeof query.accept !== "function"
        )
          throw new Error("Expected the real ownership query callback")
        query.accept(async () => reply)
      },
    )
    expectError(await f.read(), "malformed")
  }
})

test("invalid or inaccessible SDK session identity cannot acquire ownership", async () => {
  const f = fixture()
  f.replaceSession("")
  expectError(await f.read(), "malformed")
  const context = {
    get sessionManager() {
      throw new Error("fixture stale SDK context")
    },
  } as unknown as ExtensionContext
  expectError(
    await Effect.runPromise(
      Effect.either(
        getAutomaticCompressionOwner(
          f.pi,
          context,
          new AbortController().signal,
        ),
      ),
    ),
    "stale-session",
  )
})

test("session replacement also invalidates an otherwise-native controller result", async () => {
  const f = fixture()
  registerAutomaticCompressionOwner(f.pi, async () => {
    f.replaceSession()
    return { owner: "native" }
  })
  expectError(await f.read(), "stale-session")
})

test("session replacement inside external descriptor inspection invalidates the claim", async () => {
  const f = fixture()
  const reply = new Proxy(
    { owner: "billion-context", sessionId: "session-a" },
    {
      ownKeys: target => {
        f.replaceSession()
        return Reflect.ownKeys(target)
      },
    },
  )
  f.pi.events.on("pi:automatic-compression-ownership.v1", (query: unknown) => {
    if (
      !query ||
      typeof query !== "object" ||
      !("accept" in query) ||
      typeof query.accept !== "function"
    )
      throw new Error("Expected the real ownership query callback")
    query.accept(async () => reply)
  })
  expectError(await f.read(), "stale-session")
})

test("foreign ownership queries cannot execute accessors or change callbacks between reads", () => {
  const f = fixture()
  let reads = 0
  let offers = 0
  registerAutomaticCompressionOwner(f.pi, async () => ({ owner: "native" }))
  const query = {
    version: 1,
    sessionId: "session-a",
    get accept() {
      reads++
      return () => {
        offers++
      }
    },
  }
  f.pi.events.emit("pi:automatic-compression-ownership.v1", query)
  assert.equal(reads, 0)
  assert.equal(offers, 0)
})

test("foreign query descriptor traps are contained without invoking has traps", () => {
  const f = fixture()
  let hasCalls = 0
  registerAutomaticCompressionOwner(f.pi, async () => ({ owner: "native" }))
  const query = new Proxy(
    {},
    {
      has: () => {
        hasCalls++
        throw new Error("fixture has trap")
      },
      ownKeys: () => {
        throw new Error("fixture query descriptor trap")
      },
    },
  )
  assert.doesNotThrow(() =>
    f.pi.events.emit("pi:automatic-compression-ownership.v1", query),
  )
  assert.equal(hasCalls, 0)
})

test("an already cancelled request never invokes an ownership controller", async () => {
  const f = fixture()
  let calls = 0
  registerAutomaticCompressionOwner(f.pi, async () => {
    calls++
    return { owner: "billion-context", sessionId: "session-a" }
  })
  const controller = new AbortController()
  controller.abort()
  expectError(await f.read(controller.signal), "cancelled")
  assert.equal(calls, 0)
})
