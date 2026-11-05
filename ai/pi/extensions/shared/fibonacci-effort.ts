declare const fibonacciEffortBrand: unique symbol

export type FibonacciEffort = number & {
  readonly [fibonacciEffortBrand]: true
}

export const isFibonacciEffort = (value: unknown): value is FibonacciEffort => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return false
  if (value === 1) return true
  let previous = 1
  let current = 2
  while (current < value) {
    if (current > Number.MAX_SAFE_INTEGER - previous) return false
    const next = previous + current
    previous = current
    current = next
  }
  return current === value
}
