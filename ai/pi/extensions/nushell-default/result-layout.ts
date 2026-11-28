export const resultRows = (icon: string, rows: readonly string[]) => {
  const firstContent = rows.findIndex(row => row.trim().length > 0)
  if (firstContent === -1) return [...rows, "", icon]
  return [...rows.slice(0, firstContent), icon, ...rows.slice(firstContent)]
}
