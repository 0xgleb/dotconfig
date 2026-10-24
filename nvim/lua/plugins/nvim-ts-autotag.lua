-- Neovim 0.12 changed `vim.treesitter.get_parser()` to return nil when the
-- buffer has no parser, where it previously raised. nvim-ts-autotag guarded
-- that call with `pcall` alone, so `ok` came back true, `parser` came back nil,
-- and `parser:parse(true)` threw on every InsertLeave in a buffer treesitter
-- has no parser for:
--
--   internal.lua:447: attempt to index local 'parser' (a nil value)
--
-- Upstream fixed it in 88c1453 by adding the missing nil checks. That commit is
-- not in any release: the repository has no tags at all, so there is no version
-- constraint that reaches it, and the commit has to be named directly.
--
-- The pin is necessary because `lazy_setup.lua` tracks AstroNvim at
-- `version = "^5"` with `pin_plugins = nil`, which makes AstroNvim pin every
-- plugin it manages to its own known-good set. `:Lazy update` therefore
-- restores the older commit rather than advancing past it.
--
-- Delete this file once AstroNvim's pinned set includes 88c1453 or later.
---@type LazySpec
return {
  "windwp/nvim-ts-autotag",
  commit = "88c1453db4ba7dd24131086fe51fdf74e587d275",
  pin = false,
}
