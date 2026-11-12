-- Run in a Neovim session with a Rust buffer attached to rust-analyzer.
for _, client in ipairs(vim.lsp.get_clients { name = "rust_analyzer" }) do
  for bufnr in pairs(client.attached_buffers) do
    if vim.bo[bufnr].filetype == "rust" then
      assert(vim.lsp.inlay_hint.is_enabled { bufnr = bufnr }, "Rust inlay hints are disabled")
      assert(client:supports_method "textDocument/inlayHint", "Rust server does not support inlay hints")
      local hints
      assert(vim.wait(10000, function()
        hints = vim.lsp.inlay_hint.get { bufnr = bufnr }
        for _, entry in ipairs(hints) do
          if entry.inlay_hint.kind == 1 then return true end
        end
        return false
      end), "No inferred type hints reached Neovim's display cache")
      local types = {}
      for _, entry in ipairs(hints) do
        if entry.inlay_hint.kind == 1 then
          local label = entry.inlay_hint.label
          if type(label) == "table" then
            label = table.concat(vim.tbl_map(function(part) return part.value end, label))
          end
          types[#types + 1] = label
        end
      end
      return "Rust inlay hints enabled and received: " .. table.concat(types, ", ")
    end
  end
end
error "Open a Rust buffer attached to rust-analyzer before running this check"
