---@type LazySpec
-- example of importing a plugin
-- available plugins can be found at https://github.com/AstroNvim/astrocommunity
return {
  -- Add the community repository of plugin specifications
  "AstroNvim/astrocommunity",
  -- { import = "astrocommunity.pack.rust" },
  { import = "astrocommunity.editing-support.conform-nvim" },
  -- { import = "astrocommunity.colorscheme.catppuccin" },
  -- { import = "astrocommunity.pack.nix" },
}
