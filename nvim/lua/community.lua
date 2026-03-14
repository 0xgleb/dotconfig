---@type LazySpec
return {
  "AstroNvim/astrocommunity",

  -- Language packs (LSP + treesitter + formatting)
  { import = "astrocommunity.pack.rust" },
  { import = "astrocommunity.pack.nix" },
  { import = "astrocommunity.pack.typescript" },
  { import = "astrocommunity.pack.haskell" },
  { import = "astrocommunity.pack.markdown" },
  { import = "astrocommunity.pack.json" },
  { import = "astrocommunity.pack.yaml" },
  { import = "astrocommunity.pack.toml" },
  { import = "astrocommunity.pack.html-css" },
  { import = "astrocommunity.pack.terraform" },

  -- Motion (flash.nvim for SPC j jump-to-word, like doom avy)
  { import = "astrocommunity.motion.flash-nvim" },

  -- Git
  { import = "astrocommunity.git.diffview-nvim" },

  -- Project management
  { import = "astrocommunity.project.project-nvim" },
}
