-- Use the nearest .git marker: linked worktrees have a .git file of their own.
local M = {}

function M.open(action)
  local path = vim.api.nvim_buf_get_name(0)
  if vim.bo.buftype ~= "" then
    local alternate = vim.fn.bufnr "#"
    path = alternate > 0 and vim.api.nvim_buf_get_name(alternate) or ""
  end
  local cwd = vim.fn.getcwd()
  local root = path ~= "" and vim.fs.root(path, ".git") or nil
  root = root or vim.fs.root(cwd, ".git") or cwd
  require("neo-tree.command").execute {
    source = "filesystem",
    action = "focus",
    toggle = action == "toggle",
    dir = root,
    reveal = action == "reveal",
  }
end

return M
