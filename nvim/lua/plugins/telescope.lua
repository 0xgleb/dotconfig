---@type LazySpec
return {
  {
    "nvim-telescope/telescope-fzf-native.nvim",
    build = "make",
    lazy = false,
    config = function() require("telescope").load_extension "fzf" end,
    dependencies = { "nvim-telescope/telescope.nvim" },
  },
  {
    "nvim-telescope/telescope.nvim",
    opts = function(_, opts)
      local actions = require "telescope.actions"
      opts.defaults = vim.tbl_deep_extend("force", opts.defaults or {}, {
        mappings = {
          i = {
            ["<C-j>"] = actions.move_selection_next,
            ["<C-k>"] = actions.move_selection_previous,
          },
        },
        layout_strategy = "horizontal",
        layout_config = {
          horizontal = {
            prompt_position = "top",
            preview_width = 0.55,
          },
          width = 0.87,
          height = 0.80,
        },
        sorting_strategy = "ascending",
        path_display = { "truncate" },
      })
      opts.pickers = vim.tbl_deep_extend("force", opts.pickers or {}, {
        live_grep = {
          additional_args = { "--trim", "--glob", "!.worktrees/" },
        },
        find_files = {
          hidden = true,
          file_ignore_patterns = { "^%.git/", "^%.worktrees/" },
        },
      })
    end,
  },
}
