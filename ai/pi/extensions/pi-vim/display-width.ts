import { visibleWidth } from "@earendil-works/pi-tui"

export function displayColumn(text: string, codeUnitColumn: number): number {
  return visibleWidth(text.slice(0, Math.max(0, codeUnitColumn)))
}
