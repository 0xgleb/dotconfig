---@type LazySpec
return {
  "AstroNvim/astrolsp",
  ---@type AstroLSPOpts
  opts = {
    features = {
      codelens = true,
      inlay_hints = false,
      semantic_tokens = true,
    },
    formatting = {
      format_on_save = {
        enabled = true,
      },
      timeout_ms = 1000,
    },
    handlers = {
      solidity_ls_nomicfoundation = function(server, opts)
        -- Native client reuse keeps distinct Foundry roots separate.
        vim.lsp.config(server, opts)
        vim.lsp.enable(server)
      end,
    },
    servers = {
      "hls",
      "lua_ls",
      "move_analyzer",
      "nil_ls",
      "solidity_ls_nomicfoundation",
      "ts_ls",
      "svelte",
      "rust_analyzer",
    },
    config = {
      solidity_ls_nomicfoundation = {
        cmd = {
          vim.fn.stdpath "data" .. "/solidity-language-server/bin/nomicfoundation-solidity-language-server",
          "--stdio",
        },
      },
      nil_ls = {
        settings = {
          ["nil"] = {
            formatting = { command = { "nixfmt" } },
          },
        },
      },
      rust_analyzer = {
        on_new_config = function(config)
          -- Apply after workspace imports so editor checks stay on cargo check.
          local check = config.settings["rust-analyzer"].check
          check.command = "check"
          check.overrideCommand = nil
        end,
        on_attach = function(client, bufnr)
          if client:supports_method "textDocument/inlayHint" then
            vim.lsp.inlay_hint.enable(true, { bufnr = bufnr })
          end
        end,
        -- Keep macOS directory-watcher teardown out of Neovim's UI/exit path.
        capabilities = { workspace = { didChangeWatchedFiles = { dynamicRegistration = false } } },
        settings = {
          ["rust-analyzer"] = {
            check = {
              command = "check",
            },
            files = {
              watcher = "server",
              excludeDirs = { ".direnv", ".git", ".worktrees", "target" },
            },
          },
        },
      },
    },
    autocmds = {
      rust_auto_hover = {
        cond = function(client, bufnr)
          return vim.bo[bufnr].filetype == "rust" and client:supports_method "textDocument/hover"
        end,
        {
          event = "CursorHold",
          desc = "Show Rust symbol types and documentation on cursor pause",
          callback = function(args)
            if vim.api.nvim_get_mode().mode ~= "n" or vim.fn.pumvisible() == 1 then return end
            local preview = vim.b[args.buf].lsp_floating_preview
            if preview and vim.api.nvim_win_is_valid(preview) then return end
            vim.lsp.buf.hover { focus = false, silent = true, border = "rounded", max_width = 90, max_height = 14 }
          end,
        },
      },
      lsp_codelens_refresh = {
        cond = "textDocument/codeLens",
        {
          event = { "InsertLeave", "BufEnter" },
          desc = "Refresh codelens (buffer)",
          callback = function(args)
            if require("astrolsp").config.features.codelens then vim.lsp.codelens.refresh { bufnr = args.buf } end
          end,
        },
      },
    },
    mappings = {
      n = {
        gD = {
          function() vim.lsp.buf.declaration() end,
          desc = "Declaration of current symbol",
          cond = "textDocument/declaration",
        },
        ["<Leader>uY"] = {
          function() require("astrolsp.toggles").buffer_semantic_tokens() end,
          desc = "Toggle LSP semantic highlight (buffer)",
          cond = function(client)
            return client:supports_method "textDocument/semanticTokens/full" and vim.lsp.semantic_tokens ~= nil
          end,
        },
      },
    },
  },
}
