-- Home Manager supplies pinned plugin paths and registers Molten's Python host.
-- Older generations can keep using this config until the new wrapper is active.
local paths = vim.g.research_plugin_paths
if not paths then return {} end

---@type LazySpec
return {
  {
    name = "image.nvim",
    dir = paths.image,
    lazy = false,
    main = "image",
    opts = {
      backend = "kitty",
      processor = "magick_cli",
      integrations = {},
      max_width = 100,
      max_height = 12,
      max_width_window_percentage = math.huge,
      max_height_window_percentage = math.huge,
      window_overlap_clear_enabled = true,
      window_overlap_clear_ft_ignore = { "cmp_menu", "cmp_docs", "" },
    },
  },
  {
    name = "molten-nvim",
    dir = paths.molten,
    lazy = false,
    dependencies = { "image.nvim" },
    config = function()
      if paths.parsers then vim.opt.runtimepath:prepend(paths.parsers) end
      require("research.notebook").setup()
    end,
    init = function()
      vim.g.molten_image_provider = "image.nvim"
      vim.g.molten_auto_open_output = false
      vim.g.molten_virt_text_output = true
      vim.g.molten_virt_lines_off_by_1 = true
      vim.g.molten_image_location = "virt"
      vim.g.molten_output_win_max_height = 20
    end,
  },
}
