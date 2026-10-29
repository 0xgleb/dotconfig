---@type LazySpec
return {
  "lewis6991/gitsigns.nvim",
  opts = {
    -- macOS fs_event teardown blocks the editor for seconds per buffer.
    watch_gitdir = { enable = false },
  },
  specs = {
    {
      "AstroNvim/astrocore",
      opts = {
        autocmds = {
          gitsigns_refresh = {
            {
              event = { "FocusGained", "TermClose" },
              desc = "Refresh Git signs after external Git commands",
              callback = function()
                if not package.loaded.gitsigns then return end
                local signs = require "gitsigns"
                -- Re-read each comparison base without detaching buffer callbacks.
                -- refresh() alone retains the old index object. Preserve custom bases.
                local cache = require("gitsigns.cache").cache
                for buf, entry in pairs(cache) do
                  require("gitsigns.async").arun(function()
                    entry.git_obj.repo:update_abbrev_head()
                    if entry:schedule() and cache[buf] == entry and vim.api.nvim_buf_is_loaded(buf) then
                      require("gitsigns.status"):update(buf, { head = entry.git_obj.repo.abbrev_head })
                      local base = entry.file_mode and "FILE" or entry.git_obj.revision
                      vim.api.nvim_buf_call(buf, function() signs.change_base(base) end)
                    end
                  end)
                end
              end,
            },
          },
        },
      },
    },
  },
}
