---@type LazySpec
return {
  "nvim-neo-tree/neo-tree.nvim",
  opts = {
    filesystem = {
      -- Native macOS directory watchers can block start/stop on the UI thread.
      use_libuv_file_watcher = false,
      async_directory_scan = "always",
      bind_to_cwd = false,
      filtered_items = {
        visible = true,
        hide_dotfiles = false,
        hide_gitignored = false,
        never_show = {
          ".DS_Store",
        },
      },
    },
  },
}
