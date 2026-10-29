-- Run with the built Home Manager Neovim, after loading its generated init.
local ok, err = xpcall(function()
  local plugins = require("lazy.core.config").plugins
  assert(plugins["image.nvim"] and plugins["image.nvim"]._.loaded, "image.nvim did not load")
  assert(plugins["molten-nvim"] and plugins["molten-nvim"]._.loaded, "Molten did not load")
  assert(vim.fn.has "python3" == 1, "Python provider unavailable")
  assert(vim.fn.py3eval("__import__('jupyter_client').__version__") ~= "", "Jupyter client unavailable")
  assert(vim.fn.exists ":MoltenInit" == 2, "Molten remote manifest is missing its commands")
  assert(type(vim.fn.MoltenAvailableKernels()) == "table", "Molten kernel discovery failed")
end, debug.traceback)

if not ok then
  io.stderr:write(tostring(err), "\n")
  vim.cmd "cquit 1"
end
print "Research plugins, Python provider, and Molten remote registration passed"
