---@type LazySpec
return {
  {
    "nvim-treesitter/nvim-treesitter",
    opts = {
      ensure_installed = {},
      auto_install = false,
      highlight = { enable = false },
    },
  },
  {
    "folke/snacks.nvim",
    opts = {
      indent = { enabled = false },
      scope = { enabled = false },
    },
  },
}
