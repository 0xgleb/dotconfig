---@type LazySpec
return {
  {
    "nvim-treesitter/nvim-treesitter",
    opts = {
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
