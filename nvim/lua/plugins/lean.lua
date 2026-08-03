---@type LazySpec
return {
  "Julian/lean.nvim",
  ft = "lean",
  dependencies = {
    "neovim/nvim-lspconfig",
    "nvim-lua/plenary.nvim",
  },
  -- lean.nvim owns the leanls setup (infoview, abbreviations, sorries), so the
  -- server is not listed in astrolsp `servers`; astrolsp still supplies the
  -- shared on_attach, capabilities, and mappings through `lsp_opts`.
  opts = function()
    return {
      lsp = require("astrolsp").lsp_opts "leanls",
      mappings = true,
    }
  end,
}
