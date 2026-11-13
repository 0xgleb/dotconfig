local root = vim.fn.getcwd() .. "/.tmp/rust-hover-" .. vim.fn.getpid()
vim.fn.mkdir(root .. "/src", "p")
vim.fn.writefile({ '[package]', 'name = "editor_hover_probe"', 'version = "0.1.0"', 'edition = "2021"' }, root .. "/Cargo.toml")
vim.fn.writefile({ "fn main() {", '    let text = "hello".to_uppercase();', '    println!("{text}");', "}" }, root .. "/src/main.rs")
local ok, err = xpcall(function()
  if vim.env.RUST_HOVER_TEST_TOOLCHAIN then
    vim.env.PATH = vim.env.RUST_HOVER_TEST_TOOLCHAIN .. ":" .. vim.env.PATH
  end
  require("lazy").load { plugins = { "nvim-lspconfig" } }
  vim.cmd.edit(root .. "/src/main.rs")
  local bufnr = vim.api.nvim_get_current_buf()
  assert(vim.wait(30000, function()
    local client = vim.lsp.get_clients({ name = "rust_analyzer", bufnr = bufnr })[1]
    return client and client.initialized
  end), "rust-analyzer did not initialize")
  local registered, autocmds = pcall(vim.api.nvim_get_autocmds, { group = "rust_auto_hover", buffer = bufnr })
  assert(registered and #autocmds > 0,
    "Automatic Rust hover is not registered")
  local client = vim.lsp.get_clients({ name = "rust_analyzer", bufnr = bufnr })[1]
  vim.api.nvim_win_set_cursor(0, { 2, 25 })
  assert(vim.wait(30000, function()
    local response = client:request_sync("textDocument/hover", {
      textDocument = { uri = vim.uri_from_bufnr(bufnr) }, position = { line = 1, character = 25 },
    }, 2000, bufnr)
    return response and response.result and response.result.contents
  end, 500), "Library method hover is unavailable")
  local original_window = vim.api.nvim_get_current_win()
  vim.api.nvim_exec_autocmds("CursorHold", { buffer = bufnr })
  assert(vim.wait(5000, function()
    local window = vim.b[bufnr].lsp_floating_preview
    return window and vim.api.nvim_win_is_valid(window)
  end), "CursorHold did not show Rust hover")
  local window = vim.b[bufnr].lsp_floating_preview
  local lines = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(window), 0, -1, false)
  assert(table.concat(lines, "\n"):find("fn to_uppercase", 1, true), "Popup does not contain the library method signature")
  assert(vim.api.nvim_get_current_win() == original_window, "Automatic hover stole keyboard focus")
  vim.api.nvim_win_set_cursor(0, { 3, 4 })
  vim.api.nvim_exec_autocmds("CursorMoved", { buffer = bufnr })
  assert(vim.wait(1000, function() return not vim.api.nvim_win_is_valid(window) end),
    "Hover did not close when the cursor moved")
end, debug.traceback)
for _, client in ipairs(vim.lsp.get_clients { name = "rust_analyzer" }) do client:stop(true) end
vim.fn.delete(root, "rf")
if not ok then
  io.stderr:write(err .. "\n")
  vim.cmd "cquit 1"
end
print "Rust library signatures appear on cursor pause without taking focus and close on movement"
