---@type LazySpec
return {
  "AstroNvim/astroui",
  ---@type AstroUIOpts
  opts = {
    colorscheme = "astrodark",
    highlights = {
      astrodark = {
        Normal = { bg = "#000000" },
        NormalNC = { bg = "#000000" },
        NormalFloat = { bg = "#0a0a0a" },
        SignColumn = { bg = "#000000" },
        CursorLine = { bg = "#1a1a1a" },
        LineNr = { fg = "#555555" },
        CursorLineNr = { fg = "#ffff00", bold = true },
      },
    },
  },
}
