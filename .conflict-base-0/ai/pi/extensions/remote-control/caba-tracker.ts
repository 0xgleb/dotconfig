export type CabaAction =
  | "previous"
  | "minus"
  | "plus"
  | "toggle-done"
  | "next"
  | "finish"

export interface CabaSessionState {
  readonly status: "active" | "finished"
  readonly step: number
  readonly progress: readonly number[]
  readonly startedAt: number
  readonly finishedAt?: number
  readonly messageId?: number
}

interface CabaItem {
  readonly title: string
  readonly detail: string
  readonly section: string
}

const item = (section: string, title: string, detail: string): CabaItem => ({
  section,
  title,
  detail,
})

const repeated = (
  count: number,
  makeItem: (index: number) => CabaItem,
): readonly CabaItem[] =>
  Array.from({ length: count }, (_, index) => makeItem(index))

const calisthenicsRound = (round: number): readonly CabaItem[] => [
  item(
    "Calisthenics",
    `Round ${round} · Pull-ups`,
    "5 easy reps · no explosive reps · no failure",
  ),
  item("Calisthenics", `Round ${round} · Push-ups`, "10 reps"),
  item("Calisthenics", `Round ${round} · Jump squats`, "8 reps"),
  item("Calisthenics", `Round ${round} · Scapular pull-ups`, "8 reps"),
  item("Calisthenics", `Round ${round} · Reverse lunges`, "8 per leg"),
  item("Calisthenics", `Round ${round} · Scapular push-ups`, "10 reps"),
  item("Calisthenics", `Round ${round} · Rest`, "45 seconds"),
]

const cardioItems = (block: "I" | "II", seconds: number): readonly CabaItem[] =>
  repeated(15, index =>
    item(
      `Adaptive cardio ${block}`,
      `Start ${index + 1}/15`,
      `Start on ${index === 0 ? "blue" : "current ladder grade"} · next start every ${seconds}s · send up · physical fail down · technical fail stay · hard-yellow cap`,
    ),
  )

const circuitRound = (round: number): readonly CabaItem[] =>
  [
    "Green",
    "Blue A",
    "Blue B",
    "Easy Yellow A",
    "Green B",
    "Blue C",
    "Blue D",
    "Easy Yellow B",
  ].map((problem, index) =>
    item(
      "Continuous circuit",
      `Round ${round} · ${problem}`,
      `${index === 0 ? "Start" : "30s after previous drop"} · yellow fighting → substitute blue`,
    ),
  )

const supersetRounds = (
  label: string,
  count: number,
  detail: string,
): readonly CabaItem[] =>
  repeated(count, index =>
    item("Strength/prehab", `${label} · Round ${index + 1}/${count}`, detail),
  )

const CABA_ITEMS: readonly CabaItem[] = [
  ...calisthenicsRound(1),
  ...calisthenicsRound(2),
  item("Calisthenics", "Active hang 1/2", "15 seconds on jugs"),
  item("Calisthenics", "Hang rest", "30 seconds"),
  item("Calisthenics", "Active hang 2/2", "15 seconds on jugs"),
  ...repeated(4, index =>
    item(
      "Wall warm-up",
      `Green ${index + 1}/4`,
      "Different problem/angle · walk 15–30s",
    ),
  ),
  ...repeated(4, index =>
    item("Wall warm-up", `Easy blue ${index + 1}/4`, "30 seconds between"),
  ),
  ...repeated(3, index =>
    item(
      "Wall warm-up",
      `Harder blue ${index + 1}/3`,
      "Expected flash · 45 seconds between",
    ),
  ),
  ...repeated(2, index =>
    item(
      "Wall warm-up",
      `Easy yellow ${index + 1}/2`,
      "Known problem · 60 seconds between",
    ),
  ),
  item("Wall warm-up", "Complete rest", "3 minutes"),
  item(
    "Wall warm-up",
    "Forearm check",
    "Better → continue · progressively heavy/worse → conditioning stays green/blue",
  ),
  ...cardioItems("I", 60),
  item("Recovery", "Complete rest", "5 minutes"),
  ...cardioItems("II", 45),
  item("Recovery", "Complete rest", "5 minutes"),
  ...circuitRound(1),
  item("Continuous circuit", "Between-round rest", "3 minutes"),
  ...circuitRound(2),
  item("Transition", "Recover for weights", "Drink · sit · 5 minutes"),
  ...supersetRounds(
    "Superset A",
    3,
    "Bench 6–8 @ RPE 7–8 + Bulgarian split squat 8/leg · then 90s rest",
  ),
  ...supersetRounds(
    "Superset B",
    3,
    "One-arm push-ups 3–6/side + face pulls 15–20 · then 60s rest",
  ),
  ...supersetRounds(
    "Superset C",
    2,
    "External rotation 15/side + reverse wrist curls 20–25 light · then 45s rest",
  ),
] as const

const ITEM_COUNT = CABA_ITEMS.length

export const initialCabaSession = (startedAt: number): CabaSessionState => ({
  status: "active",
  step: 0,
  progress: CABA_ITEMS.map(() => 0),
  startedAt,
})

const LEGACY_SECTION_RANGES = [
  [0, 14, 2],
  [14, 17, 2],
  [17, 21, 4],
  [21, 28, 7],
  [28, 30, 2],
  [30, 45, 15],
  [45, 46, 1],
  [46, 61, 15],
  [61, 62, 1],
  [62, 80, 2],
  [80, 81, 1],
  [81, 87, 6],
  [87, 90, 2],
] as const

export const migrateCabaSession = (
  value: unknown,
): CabaSessionState | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    (value.status !== "active" && value.status !== "finished") ||
    !("step" in value) ||
    typeof value.step !== "number" ||
    !Number.isSafeInteger(value.step) ||
    value.step < 0 ||
    value.step >= LEGACY_SECTION_RANGES.length ||
    !("progress" in value) ||
    !Array.isArray(value.progress) ||
    value.progress.length !== LEGACY_SECTION_RANGES.length ||
    !value.progress.every(
      progress =>
        typeof progress === "number" &&
        Number.isSafeInteger(progress) &&
        progress >= 0,
    ) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0
  )
    return undefined
  const progress = CABA_ITEMS.map(() => 0)
  for (const [
    index,
    [start, end, legacyTarget],
  ] of LEGACY_SECTION_RANGES.entries()) {
    const completed = Math.min(
      end - start,
      Math.ceil(((value.progress[index] ?? 0) / legacyTarget) * (end - start)),
    )
    progress.fill(1, start, start + completed)
  }
  const [step] = LEGACY_SECTION_RANGES[value.step] ?? [0, 1, 1]
  const finishedAt =
    "finishedAt" in value &&
    typeof value.finishedAt === "number" &&
    Number.isSafeInteger(value.finishedAt) &&
    value.finishedAt >= value.startedAt
      ? value.finishedAt
      : undefined
  if (value.status === "finished" && finishedAt === undefined) return undefined
  return {
    status: value.status,
    step,
    progress,
    startedAt: value.startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...("messageId" in value &&
    typeof value.messageId === "number" &&
    Number.isSafeInteger(value.messageId) &&
    value.messageId >= 0
      ? { messageId: value.messageId }
      : {}),
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export const parseCabaSession = (
  value: unknown,
): CabaSessionState | undefined => {
  if (
    !isRecord(value) ||
    (value.status !== "active" && value.status !== "finished") ||
    typeof value.step !== "number" ||
    !Number.isSafeInteger(value.step) ||
    value.step < 0 ||
    value.step >= ITEM_COUNT ||
    !Array.isArray(value.progress) ||
    value.progress.length !== ITEM_COUNT ||
    !value.progress.every(progress => progress === 0 || progress === 1) ||
    !isTimestamp(value.startedAt) ||
    (value.messageId !== undefined && !isTimestamp(value.messageId)) ||
    (value.finishedAt !== undefined && !isTimestamp(value.finishedAt)) ||
    (value.status === "active" && value.finishedAt !== undefined) ||
    (value.status === "finished" &&
      (value.finishedAt === undefined || value.finishedAt < value.startedAt))
  )
    return undefined
  return {
    status: value.status,
    step: value.step,
    progress: value.progress as readonly number[],
    startedAt: value.startedAt,
    ...(typeof value.finishedAt === "number"
      ? { finishedAt: value.finishedAt }
      : {}),
    ...(typeof value.messageId === "number"
      ? { messageId: value.messageId }
      : {}),
  }
}

export const advanceCabaSession = (
  state: CabaSessionState,
  action: CabaAction,
  now = Date.now(),
): CabaSessionState => {
  if (state.status === "finished") return state
  if (action === "finish")
    return { ...state, status: "finished", finishedAt: now }
  if (action === "previous")
    return { ...state, step: Math.max(0, state.step - 1) }
  if (action === "next")
    return { ...state, step: Math.min(ITEM_COUNT - 1, state.step + 1) }
  const progress = [...state.progress]
  progress[state.step] = state.progress[state.step] === 1 ? 0 : 1
  return { ...state, progress }
}

export interface CabaInlineButton {
  readonly text: string
  readonly callback_data: string
}

export interface CabaSessionCard {
  readonly text: string
  readonly replyMarkup: {
    readonly inline_keyboard: readonly (readonly CabaInlineButton[])[]
  }
}

const elapsed = (state: CabaSessionState, now: number): string => {
  const minutes = Math.max(
    0,
    Math.floor(((state.finishedAt ?? now) - state.startedAt) / 60_000),
  )
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
}

export const cabaSessionCard = (
  state: CabaSessionState,
  now = Date.now(),
): CabaSessionCard => {
  const currentItem = CABA_ITEMS[state.step] ?? CABA_ITEMS[0]
  const completed = state.progress.filter(progress => progress === 1).length
  const done = state.progress[state.step] === 1
  const finished = state.status === "finished"
  return {
    text: [
      `<b>🧗 Boulder CABA</b> · ${finished ? "finished" : "live"} · ${elapsed(state, now)}`,
      `Overall: <b>${completed}/${ITEM_COUNT}</b> items`,
      "",
      `<b>Item ${state.step + 1}/${ITEM_COUNT} · ${currentItem.section}</b>`,
      `<b>${currentItem.title}</b>`,
      currentItem.detail,
      "",
      `Status: <b>${done ? "done ✅" : "pending"}</b>`,
      "No orange/red · movement quality beats volume.",
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "◀ Prev", callback_data: "caba:previous" },
          {
            text: done ? "↩ Undo" : "✅ Done",
            callback_data: "caba:toggle-done",
          },
          { text: "Next ▶", callback_data: "caba:next" },
        ],
        [{ text: "🏁 Finish", callback_data: "caba:finish" }],
      ],
    },
  }
}
