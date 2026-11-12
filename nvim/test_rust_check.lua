local root = vim.fn.tempname()
vim.fn.mkdir(root .. "/.vscode", "p")
vim.fn.mkdir(root .. "/.git", "p")
vim.fn.writefile({ '{"rust-analyzer.check.command":"clippy"}' }, root .. "/.vscode/settings.json")
local ok, err = xpcall(function()
  require("lazy").load { plugins = { "nvim-lspconfig" } }
  local config = vim.deepcopy(require("lspconfig").rust_analyzer.manager.config)
  assert(config.on_new_config, "Missing workspace configuration hook")
  config.on_new_config(config, root)
  assert(config.settings["rust-analyzer"].check.command == "check", "Workspace settings overrode cargo check")
  assert(config.settings["rust-analyzer"].check.overrideCommand == nil, "A custom check command bypasses cargo check")
end, debug.traceback)
vim.fn.delete(root, "rf")
if not ok then
  io.stderr:write(err .. "\n")
  vim.cmd "cquit 1"
end
print "Rust uses cargo check despite workspace Clippy settings"
