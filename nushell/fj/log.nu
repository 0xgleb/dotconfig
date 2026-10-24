export def info [msg: string] {
  print $"(ansi green) INF (ansi reset) ($msg)"
}

export def debug [msg: string] {
  print $"(ansi blue) DBG (ansi reset) ($msg)"
}

export def warning [msg: string] {
  print $"(ansi yellow) WRN (ansi reset) ($msg)"
}

export def error [msg: string] {
  print $"(ansi red) ERR (ansi reset) ($msg)"
}
