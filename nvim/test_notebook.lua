-- Run in an owned Neovim with the research shell and this config on runtimepath.
local notebook = require "research.notebook"
vim.g.maplocalleader = ","
assert(type(notebook.setup) == "function")
local root = assert(vim.env.RESEARCH_TEST_ROOT)
notebook.setup()
vim.cmd.edit(root .. "/workflow.ipynb")
assert(vim.bo.filetype == "markdown", "notebook must open as Markdown")
local found_run = false
for _, mapping in ipairs(vim.api.nvim_buf_get_keymap(0, "n")) do
  if mapping.lhs == ",r" and mapping.desc == "Run notebook cell" then found_run = true end
end
assert(found_run, "notebook cell execution must use comma localleader")
local original = vim.api.nvim_buf_get_lines(0, 0, -1, false)
assert(table.concat(original, "\n"):find("```haskell", 1, true))
vim.cmd.write()
assert(not vim.bo.modified, "successful save must clear modified")
notebook.share(root)
local path = root .. "/workflow.ipynb"
local read = notebook.request { op = "read", path = path }
assert(read.ok and read.source:find("Synthetic workflow", 1, true))
vim.api.nvim_buf_set_lines(0, -1, -1, false, { "Human unsaved note" })
local conflict = notebook.request {
  op = "patch",
  path = path,
  changedtick = read.changedtick,
  old = "Synthetic workflow",
  new = "Changed",
}
assert(not conflict.ok, "stale revisions must fail")
read = notebook.request { op = "read", path = path }
local patched = notebook.request {
  op = "patch",
  path = path,
  changedtick = read.changedtick,
  old = "Synthetic workflow",
  new = "Synthetic workflow, agent edit",
}
assert(patched.ok and vim.bo.modified)
local updated = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n")
assert(updated:find("Human unsaved note", 1, true))
assert(updated:find("Synthetic workflow, agent edit", 1, true))
vim.cmd.undo()
local undone = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n")
assert(undone:find("Human unsaved note", 1, true) and not undone:find("agent edit", 1, true))
local escaped = notebook.request { op = "read", path = "/etc/hosts" }
assert(not escaped.ok)
read = notebook.request { op = "read", path = path }
vim.bo.readonly = true
local readonly = notebook.request {
  op = "patch",
  path = path,
  changedtick = read.changedtick,
  old = "Synthetic workflow",
  new = "Changed",
}
assert(not readonly.ok and notebook.request({ op = "read", path = path }).source == read.source)
vim.bo.readonly = false
vim.api.nvim_buf_set_lines(0, -1, -1, false, { "duplicate fragment", "duplicate fragment" })
read = notebook.request { op = "read", path = path }
local ambiguous = notebook.request {
  op = "patch",
  path = path,
  changedtick = read.changedtick,
  old = "duplicate fragment",
  new = "Changed",
}
assert(not ambiguous.ok and notebook.request({ op = "read", path = path }).source == read.source)
local forbidden = notebook.request { op = "execute", path = path }
assert(not forbidden.ok)
print "Notebook: conversion, save, conflicts, live edit, undo, read-only, ambiguity, and path boundary passed"
