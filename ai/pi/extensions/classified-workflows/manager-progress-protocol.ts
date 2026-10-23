import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { Data, Either } from "effect"
import {
  isManagerPairScope,
  isManagerProtocolIdentifier,
  type ManagerPairScope,
} from "./manager-pair-protocol.ts"
import {
  isOwnerAllowanceTimestamp,
  OWNER_PROGRESS_CHECK_IN_MS,
  SUPERVISED_OWNER_ALLOWANCE_MS,
} from "./owner-allowance.ts"

export interface ManagerProgressIntent extends ManagerPairScope {
  readonly managerSessionId: string
  readonly ownerAt: number
  readonly deadlineAt: number
  readonly sequence: number
  readonly scheduledAt: number
  readonly revision: string
}

export interface ManagerProgressRequest extends ManagerProgressIntent {
  readonly version: 1
  readonly kind: "manager-progress-check-in"
  readonly id: string
  readonly signature: string
}

export class ManagerProgressError extends Data.TaggedError(
  "ManagerProgressError",
)<{
  readonly code:
    "malformed" | "scope" | "expired" | "not-due" | "authentication" | "crypto"
  readonly message: string
}> {}

export const signManagerProgressRequest = (
  intent: ManagerProgressIntent,
  capability: string,
  now: number,
): Either.Either<ManagerProgressRequest, ManagerProgressError> =>
  Either.gen(function* () {
    if (!hexDigest(capability)) return yield* malformed()

    const fields = yield* dataFields(intent, intentKeys)
    const decoded = yield* decodeIntentFields(fields)
    yield* atTime(decoded, now)

    const body = yield* requestBody(decoded)
    const signed = yield* signature(body, capability)

    return Object.freeze({ ...body, signature: signed })
  })

export const verifyManagerProgressRequest = (
  value: unknown,
  scope: ManagerPairScope,
  managerSessionId: string,
  capability: string,
  now: number,
): Either.Either<ManagerProgressRequest, ManagerProgressError> =>
  Either.gen(function* () {
    if (
      !hexDigest(capability) ||
      !isManagerProtocolIdentifier(managerSessionId)
    )
      return yield* malformed()

    const fields = yield* dataFields(value, requestKeys)

    if (
      fields.version !== 1 ||
      fields.kind !== kind ||
      !hexDigest(fields.id) ||
      !hexDigest(fields.signature)
    )
      return yield* malformed()

    const decoded = yield* decodeIntentFields(fields)
    const expectedScope = yield* Either.try({
      try: () => ({ workerSessionId: scope.workerSessionId, cwd: scope.cwd }),
      catch: () =>
        new ManagerProgressError({
          code: "malformed",
          message: "Expected progress scope could not be inspected.",
        }),
    })

    if (!isManagerPairScope(expectedScope)) return yield* malformed()
    if (
      decoded.workerSessionId !== expectedScope.workerSessionId ||
      decoded.cwd !== expectedScope.cwd ||
      decoded.managerSessionId !== managerSessionId
    )
      return yield* failure(
        "scope",
        "Progress check-in targets another worker or manager.",
      )

    yield* atTime(decoded, now)

    const body = yield* requestBody(decoded)

    if (body.id !== fields.id)
      return yield* failure(
        "authentication",
        "Progress interval identity does not match its scope.",
      )

    const expectedSignature = yield* signature(body, capability)
    const suppliedSignature = fields.signature
    const authenticated = yield* Either.try({
      try: () =>
        timingSafeEqual(
          Buffer.from(expectedSignature, "hex"),
          Buffer.from(suppliedSignature, "hex"),
        ),
      catch: () =>
        new ManagerProgressError({
          code: "crypto",
          message: "Progress authentication could not be checked.",
        }),
    })

    if (!authenticated)
      return yield* failure(
        "authentication",
        "Progress check-in authentication failed.",
      )

    return Object.freeze({ ...body, signature: suppliedSignature })
  })

const kind = "manager-progress-check-in" as const
const intentKeys = [
  "workerSessionId",
  "cwd",
  "managerSessionId",
  "ownerAt",
  "deadlineAt",
  "sequence",
  "scheduledAt",
  "revision",
] as const
const requestKeys = [
  ...intentKeys,
  "version",
  "kind",
  "id",
  "signature",
] as const
const hexDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)
const failure = (code: ManagerProgressError["code"], message: string) =>
  Either.left(new ManagerProgressError({ code, message }))
const malformed = () =>
  failure("malformed", "Progress check-in fields are malformed.")

const dataFields = (
  value: unknown,
  keys: readonly string[],
): Either.Either<Readonly<Record<string, unknown>>, ManagerProgressError> => {
  if (typeof value !== "object" || value === null) return malformed()

  return Either.flatMap(
    Either.try({
      try: () => ({
        isArray: Array.isArray(value),
        descriptors: Object.getOwnPropertyDescriptors(value),
      }),
      catch: () =>
        new ManagerProgressError({
          code: "malformed",
          message: "Progress check-in fields could not be inspected.",
        }),
    }),
    ({ isArray, descriptors }) => {
      if (isArray || Reflect.ownKeys(descriptors).length !== keys.length)
        return malformed()

      return Either.map(
        Either.all(
          keys.map(key => {
            if (!Object.hasOwn(descriptors, key)) return malformed()

            const descriptor = descriptors[key]

            if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
              return malformed()

            return Either.right([key, descriptor.value] as const)
          }),
        ),
        fields => Object.freeze(Object.fromEntries(fields)),
      )
    },
  )
}

const decodeIntentFields = (
  fields: Readonly<Record<string, unknown>>,
): Either.Either<ManagerProgressIntent, ManagerProgressError> => {
  const {
    workerSessionId,
    cwd,
    managerSessionId,
    ownerAt,
    deadlineAt,
    sequence,
    scheduledAt,
    revision,
  } = fields

  if (
    typeof workerSessionId !== "string" ||
    typeof cwd !== "string" ||
    !isManagerPairScope({ workerSessionId, cwd }) ||
    !isManagerProtocolIdentifier(managerSessionId) ||
    !isManagerProtocolIdentifier(revision) ||
    !isOwnerAllowanceTimestamp(ownerAt) ||
    !isOwnerAllowanceTimestamp(deadlineAt) ||
    !isOwnerAllowanceTimestamp(ownerAt + SUPERVISED_OWNER_ALLOWANCE_MS) ||
    deadlineAt <= ownerAt ||
    deadlineAt > ownerAt + SUPERVISED_OWNER_ALLOWANCE_MS ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    !isOwnerAllowanceTimestamp(scheduledAt) ||
    scheduledAt !== ownerAt + sequence * OWNER_PROGRESS_CHECK_IN_MS ||
    scheduledAt >= deadlineAt
  )
    return malformed()

  return Either.right(
    Object.freeze({
      workerSessionId,
      cwd,
      managerSessionId,
      ownerAt,
      deadlineAt,
      sequence,
      scheduledAt,
      revision,
    }),
  )
}

const atTime = (
  intent: ManagerProgressIntent,
  now: number,
): Either.Either<void, ManagerProgressError> => {
  if (!isOwnerAllowanceTimestamp(now)) return malformed()
  if (now >= intent.deadlineAt)
    return failure(
      "expired",
      "The worker allowance for this progress check-in has expired.",
    )
  if (now < intent.scheduledAt)
    return failure("not-due", "This progress check-in is not due yet.")

  return Either.right(undefined)
}

const requestBody = (intent: ManagerProgressIntent) =>
  Either.map(
    Either.try({
      try: () =>
        createHash("sha256")
          .update(
            JSON.stringify({
              kind,
              workerSessionId: intent.workerSessionId,
              cwd: intent.cwd,
              ownerAt: intent.ownerAt,
              sequence: intent.sequence,
            }),
          )
          .digest("hex"),
      catch: () =>
        new ManagerProgressError({
          code: "crypto",
          message: "Progress interval identity could not be calculated.",
        }),
    }),
    id => Object.freeze({ version: 1 as const, kind, id, ...intent }),
  )

const signature = (
  body: Omit<ManagerProgressRequest, "signature">,
  capability: string,
) =>
  Either.try({
    try: () =>
      createHmac("sha256", capability)
        .update(JSON.stringify(body))
        .digest("hex"),
    catch: () =>
      new ManagerProgressError({
        code: "crypto",
        message: "Progress check-in signing failed.",
      }),
  })
