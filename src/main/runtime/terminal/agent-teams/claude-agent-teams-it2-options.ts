type ParsedOptions = {
  flags: Set<string>
  values: Map<string, string>
  positional: string[]
}

export function parseIt2Options(
  args: string[],
  valueFlags: Set<string>,
  boolFlags: Set<string>
): ParsedOptions {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
  let options = true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && boolFlags.has(arg)) {
      flags.add(arg)
      continue
    }
    if (options && valueFlags.has(arg)) {
      const value = args[++i]
      if (!value || value.startsWith('-')) {
        throw new Error(`missing value for ${arg}`)
      }
      values.set(arg, value)
      continue
    }
    if (options && arg.startsWith('-')) {
      throw new Error(`unsupported option: ${arg}`)
    }
    positional.push(arg)
  }
  return { flags, values, positional }
}
