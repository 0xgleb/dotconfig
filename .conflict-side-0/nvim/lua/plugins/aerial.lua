-- AstroNvim v5 pins aerial.nvim to "^2.2", but aerial 2.x calls
-- iter_matches({ all = false }), an option Neovim 0.12 removed, so the
-- treesitter backend crashes with "attempt to call method 'type' (a nil
-- value)". Upstream fixed this in 3.0.0 and 4.x targets Neovim 0.12, so
-- override the version pin.

---@type LazySpec
return {
  "stevearc/aerial.nvim",
  version = "^4",
}
