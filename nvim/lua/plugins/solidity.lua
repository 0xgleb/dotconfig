---@type LazySpec
return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        solidity_ls = {},
      },
    },
  },
}
