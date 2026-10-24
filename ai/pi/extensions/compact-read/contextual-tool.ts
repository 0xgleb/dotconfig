export function executeWithContextCwd<Args extends unknown[], Result>(
  cwd: string,
  createTool: (cwd: string) => { execute: (...args: Args) => Promise<Result> },
  args: Args,
): Promise<Result> {
  return createTool(cwd).execute(...args)
}
