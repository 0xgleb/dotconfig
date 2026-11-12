local ok, err = xpcall(function()
  vim.cmd.enew()
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {
    "struct Position { amount: u64 }",
    "enum Status { Open, Closed }",
    "trait Account {}",
    "type Balance = u64;",
    "fn identity<T: Account>(value: T) -> T { value }",
    "fn main() { let position = Position { amount: 42 }; }",
  })
  vim.bo.filetype = "rust"
  require("lazy").load { plugins = { "nvim-treesitter" } }
  local bufnr = vim.api.nvim_get_current_buf()
  assert(vim.wait(3000, function() return vim.treesitter.highlighter.active[bufnr] ~= nil end),
    "Rust Tree-sitter highlighting did not attach")
  local parser = assert(vim.treesitter.get_parser(bufnr, "rust"))
  local tree = parser:parse()[1]
  assert(not tree:root():has_error(), "Rust fixture has parse errors")
  local query = assert(vim.treesitter.query.get("rust", "highlights"))
  local captures = {}
  for id, node in query:iter_captures(tree:root(), bufnr, 0, -1) do
    local text = vim.treesitter.get_node_text(node, bufnr)
    captures[text] = captures[text] or {}
    captures[text][query.captures[id]] = true
  end
  for _, name in ipairs { "Position", "Status", "Account", "Balance", "T" } do
    assert(captures[name] and captures[name].type, "Missing type capture: " .. name)
  end
  assert(captures.u64 and captures.u64["type.builtin"], "Missing primitive type capture")
  local type_color = vim.api.nvim_get_hl(0, { name = "@type.rust", link = false }).fg
  local text_color = vim.api.nvim_get_hl(0, { name = "Normal", link = false }).fg
  assert(type_color and type_color ~= text_color, "Rust types have no distinct color")
  local configs = require "nvim-treesitter.configs"
  assert(configs.get_module("highlight").disable("lua", bufnr), "Highlighting changed for other languages")
  local large_path = vim.fn.tempname() .. ".rs"
  vim.fn.writefile(vim.fn["repeat"]({ "// large buffer" }, 10001), large_path)
  vim.cmd.edit(large_path)
  local large_bufnr = vim.api.nvim_get_current_buf()
  vim.fn.delete(large_path)
  assert(not configs.is_enabled("highlight", "rust", large_bufnr), "Large-buffer safeguard missing")
end, debug.traceback)
if not ok then
  io.stderr:write(err .. "\n")
  vim.cmd "cquit 1"
end
print "Rust type captures, colors, scope, and large-buffer safeguard passed"
