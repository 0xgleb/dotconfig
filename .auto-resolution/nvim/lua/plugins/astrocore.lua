---@type LazySpec
return {
  "AstroNvim/astrocore",
  ---@type AstroCoreOpts
  opts = {
    features = {
      large_buf = { size = 1024 * 256, lines = 10000 },
      autopairs = true,
      cmp = true,
      diagnostics = { virtual_text = false, virtual_lines = true },
      highlighturl = true,
      notifications = true,
    },
    diagnostics = {
      virtual_text = false,
      virtual_lines = true,
      underline = true,
    },
    options = {
      opt = {
        relativenumber = true,
        number = true,
        spell = false,
        signcolumn = "yes",
        wrap = false,
        scrolloff = 8,
        sidescrolloff = 8,
        clipboard = "unnamedplus",
        confirm = false,
      },
    },
    mappings = {
      n = {
        -- ╭─────────────────────────────────────────╮
        -- │ Top-level Doom bindings                  │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>/"] = { function() require("telescope.builtin").live_grep() end, desc = "Search project" },
        ["<Leader><Space>"] = { function() require("telescope.builtin").find_files() end, desc = "Find file in project" },
        ["<Leader>."] = { function() require("telescope.builtin").find_files() end, desc = "Find file" },
        ["<Leader>,"] = { function() require("telescope.builtin").buffers() end, desc = "Switch buffer" },
        ["<Leader>:"] = { function() require("telescope.builtin").commands() end, desc = "Command palette" },
        ["<M-x>"] = { function() require("telescope.builtin").commands() end, desc = "Command palette" },
        ["<Leader>;"] = { ":", desc = "Enter command" },
        ["<Leader>x"] = { function() require("astrocore.buffer").close() end, desc = "Close buffer" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC j — Jump (avy/flash)                 │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>j"] = { function() require("flash").jump() end, desc = "Jump to word" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC b — Buffer                           │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>b"] = { desc = "Buffer" },
        ["<Leader>bb"] = { function() require("telescope.builtin").buffers() end, desc = "Switch buffer" },
        ["<Leader>bk"] = { function() require("astrocore.buffer").close() end, desc = "Kill buffer" },
        ["<Leader>bd"] = { function() require("astrocore.buffer").close() end, desc = "Kill buffer" },
        ["<Leader>bn"] = { function() require("astrocore.buffer").nav(1) end, desc = "Next buffer" },
        ["<Leader>bp"] = { function() require("astrocore.buffer").nav(-1) end, desc = "Previous buffer" },
        ["<Leader>br"] = { "<Cmd>edit!<CR>", desc = "Revert buffer" },
        ["<Leader>bs"] = { "<Cmd>w<CR>", desc = "Save buffer" },
        ["<Leader>bS"] = { "<Cmd>wa<CR>", desc = "Save all buffers" },
        ["<Leader>bo"] = {
          function() require("astrocore.buffer").close_all(true) end,
          desc = "Kill other buffers",
        },
        ["<Leader>b]"] = { function() require("astrocore.buffer").nav(1) end, desc = "Next buffer" },
        ["<Leader>b["] = { function() require("astrocore.buffer").nav(-1) end, desc = "Previous buffer" },
        ["]b"] = { function() require("astrocore.buffer").nav(vim.v.count1) end, desc = "Next buffer" },
        ["[b"] = { function() require("astrocore.buffer").nav(-vim.v.count1) end, desc = "Previous buffer" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC c — Code / LSP                       │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>c"] = false,
        ["<Leader>cd"] = { function() vim.lsp.buf.definition() end, desc = "Go to definition" },
        ["<Leader>cD"] = { function() vim.lsp.buf.references() end, desc = "Find references" },
        ["<Leader>ca"] = { function() vim.lsp.buf.code_action() end, desc = "Code action" },
        ["<Leader>cr"] = { function() vim.lsp.buf.rename() end, desc = "Rename symbol" },
        ["<Leader>cf"] = { function() vim.lsp.buf.format { async = true } end, desc = "Format buffer" },
        ["<Leader>ci"] = { function() vim.lsp.buf.implementation() end, desc = "Go to implementation" },
        ["<Leader>ck"] = { function() vim.lsp.buf.hover() end, desc = "Hover documentation" },
        ["<Leader>cs"] = { function() vim.lsp.buf.signature_help() end, desc = "Signature help" },
        ["<Leader>cx"] = { function() require("telescope.builtin").diagnostics { bufnr = 0 } end, desc = "List errors" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC f — File                             │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>f"] = { desc = "File" },
        ["<Leader>ff"] = { function() require("telescope.builtin").find_files() end, desc = "Find file" },
        ["<Leader>fr"] = { function() require("telescope.builtin").oldfiles() end, desc = "Recent files" },
        ["<Leader>fs"] = { "<Cmd>w<CR>", desc = "Save file" },
        ["<Leader>fy"] = {
          function()
            local path = vim.fn.expand "%:~:."
            vim.fn.setreg("+", path)
            vim.notify("Copied: " .. path)
          end,
          desc = "Yank file path",
        },
        ["<Leader>fY"] = {
          function()
            local path = vim.fn.expand "%:p"
            vim.fn.setreg("+", path)
            vim.notify("Copied: " .. path)
          end,
          desc = "Yank absolute path",
        },
        ["<Leader>fp"] = {
          function() require("telescope.builtin").find_files { cwd = vim.fn.stdpath "config" } end,
          desc = "Find config file",
        },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC g — Git                              │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>g"] = { desc = "Git" },
        ["<Leader>gg"] = {
          function() require("astrocore").toggle_term_cmd "gitui" end,
          desc = "Git status (gitui)",
        },
        ["<Leader>gb"] = { function() require("gitsigns").blame_line { full = true } end, desc = "Git blame line" },
        ["<Leader>gB"] = { function() require("gitsigns").blame() end, desc = "Git blame buffer" },
        ["<Leader>gd"] = { function() require("gitsigns").diffthis() end, desc = "Git diff" },
        ["<Leader>gp"] = { function() require("gitsigns").preview_hunk() end, desc = "Preview hunk" },
        ["<Leader>gr"] = { function() require("gitsigns").reset_hunk() end, desc = "Reset hunk" },
        ["<Leader>gR"] = { function() require("gitsigns").reset_buffer() end, desc = "Reset buffer" },
        ["<Leader>gS"] = { function() require("gitsigns").stage_hunk() end, desc = "Stage hunk" },
        ["<Leader>gU"] = { function() require("gitsigns").undo_stage_hunk() end, desc = "Unstage hunk" },
        ["<Leader>gl"] = {
          function() require("astrocore").toggle_term_cmd "gitui" end,
          desc = "Git log (gitui)",
        },
        ["<Leader>g]"] = { function() require("gitsigns").nav_hunk("next") end, desc = "Next hunk" },
        ["<Leader>g["] = { function() require("gitsigns").nav_hunk("prev") end, desc = "Previous hunk" },
        ["]d"] = { function() require("gitsigns").nav_hunk("next") end, desc = "Next hunk" },
        ["[d"] = { function() require("gitsigns").nav_hunk("prev") end, desc = "Previous hunk" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC h — Help                             │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>h"] = { desc = "Help" },
        ["<Leader>hk"] = { function() require("telescope.builtin").keymaps() end, desc = "Describe keybindings" },
        ["<Leader>hh"] = { function() require("telescope.builtin").help_tags() end, desc = "Help tags" },
        ["<Leader>hm"] = { function() require("telescope.builtin").man_pages() end, desc = "Man pages" },
        ["<Leader>ht"] = { function() require("telescope.builtin").colorscheme { enable_preview = true } end, desc = "Change theme" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC o — Open                             │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>o"] = { desc = "Open" },
        ["<Leader>on"] = { "<Cmd>Neotree toggle<CR>", desc = "File tree" },
        ["<Leader>oN"] = { "<Cmd>Neotree reveal<CR>", desc = "File tree (reveal current)" },
        ["<Leader>op"] = { "<Cmd>Neotree toggle<CR>", desc = "Project sidebar" },
        ["<Leader>ot"] = { "<Cmd>ToggleTerm<CR>", desc = "Terminal" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC p — Project                          │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>p"] = { desc = "Project" },
        ["<Leader>pf"] = { function() require("telescope.builtin").live_grep() end, desc = "Search project" },
        ["<Leader>pr"] = { function() require("telescope.builtin").oldfiles() end, desc = "Recent project files" },
        ["<Leader>pp"] = { function() require("telescope").extensions.projects.projects {} end, desc = "Switch project" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC q — Quit                             │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>q"] = { desc = "Quit" },
        ["<Leader>qd"] = { function() require("snacks").dashboard() end, desc = "Dashboard" },
        ["<Leader>qq"] = { "<Cmd>qa<CR>", desc = "Quit" },
        ["<Leader>qQ"] = { "<Cmd>qa!<CR>", desc = "Quit without saving" },
        ["<Leader>qs"] = { "<Cmd>wqa<CR>", desc = "Save and quit" },
        ["<Leader>qr"] = { "<Cmd>cq<CR>", desc = "Restart (exit with error code)" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC s — Search                           │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>s"] = { desc = "Search" },
        ["<Leader>ss"] = { function() require("telescope.builtin").current_buffer_fuzzy_find() end, desc = "Search buffer" },
        ["<Leader>sS"] = {
          function() require("telescope.builtin").current_buffer_fuzzy_find { default_text = vim.fn.expand "<cword>" } end,
          desc = "Search buffer (word at point)",
        },
        ["<Leader>sp"] = { function() require("telescope.builtin").live_grep() end, desc = "Search project" },
        ["<Leader>sP"] = {
          function() require("telescope.builtin").live_grep { default_text = vim.fn.expand "<cword>" } end,
          desc = "Search project (word at point)",
        },
        ["<Leader>sd"] = {
          function()
            require("telescope.builtin").live_grep { search_dirs = { vim.fn.expand "%:p:h" } }
          end,
          desc = "Search directory",
        },
        ["<Leader>sb"] = { function() require("telescope.builtin").buffers() end, desc = "Search buffers" },
        ["<Leader>si"] = { function() require("telescope.builtin").lsp_document_symbols() end, desc = "Search symbols" },
        ["<Leader>sI"] = { function() require("telescope.builtin").lsp_workspace_symbols() end, desc = "Search symbols (workspace)" },
        ["<Leader>sr"] = { function() require("telescope.builtin").resume() end, desc = "Resume last search" },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC t — Toggle                           │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>t"] = { desc = "Toggle" },
        ["<Leader>tl"] = {
          function()
            vim.opt.number = not vim.opt.number:get()
            vim.opt.relativenumber = not vim.opt.relativenumber:get()
          end,
          desc = "Toggle line numbers",
        },
        ["<Leader>tw"] = { function() vim.opt.wrap = not vim.opt.wrap:get() end, desc = "Toggle word wrap" },
        ["<Leader>ts"] = { function() vim.opt.spell = not vim.opt.spell:get() end, desc = "Toggle spell check" },
        ["<Leader>tf"] = { function() require("astrolsp.toggles").buffer_autoformat() end, desc = "Toggle format on save" },
        ["<Leader>td"] = { function() require("astrolsp.toggles").diagnostics() end, desc = "Toggle diagnostics" },
        ["<Leader>tD"] = {
          function()
            local current = vim.diagnostic.config()
            if current.virtual_lines then
              vim.diagnostic.config { virtual_lines = false, virtual_text = true }
            else
              vim.diagnostic.config { virtual_lines = true, virtual_text = false }
            end
          end,
          desc = "Toggle diagnostic style (lines/text)",
        },

        -- ╭─────────────────────────────────────────╮
        -- │ SPC w — Window                           │
        -- ╰─────────────────────────────────────────╯
        ["<Leader>w"] = { desc = "Window" },
        ["<Leader>wh"] = { "<C-w>h", desc = "Window left" },
        ["<Leader>wj"] = { "<C-w>j", desc = "Window down" },
        ["<Leader>wk"] = { "<C-w>k", desc = "Window up" },
        ["<Leader>wl"] = { "<C-w>l", desc = "Window right" },
        ["<Leader>ws"] = { "<C-w>s", desc = "Horizontal split" },
        ["<Leader>wv"] = { "<C-w>v", desc = "Vertical split" },
        ["<Leader>wc"] = { "<C-w>c", desc = "Close window" },
        ["<Leader>wd"] = { "<C-w>c", desc = "Close window" },
        ["<Leader>wq"] = { "<C-w>q", desc = "Quit window" },
        ["<Leader>ww"] = { "<C-w>w", desc = "Next window" },
        ["<Leader>wW"] = { "<C-w>W", desc = "Previous window" },
        ["<Leader>wo"] = { "<C-w>o", desc = "Only window" },
        ["<Leader>wm"] = { "<C-w>o", desc = "Maximize window" },
        ["<Leader>w="] = { "<C-w>=", desc = "Balance windows" },
        ["<Leader>wH"] = { "<C-w>H", desc = "Move window left" },
        ["<Leader>wJ"] = { "<C-w>J", desc = "Move window down" },
        ["<Leader>wK"] = { "<C-w>K", desc = "Move window up" },
        ["<Leader>wL"] = { "<C-w>L", desc = "Move window right" },
        ["<Leader>w+"] = { "<C-w>+", desc = "Increase height" },
        ["<Leader>w-"] = { "<C-w>-", desc = "Decrease height" },
        ["<Leader>w>"] = { "<C-w>>", desc = "Increase width" },
        ["<Leader>w<"] = { "<C-w><", desc = "Decrease width" },

        -- ╭─────────────────────────────────────────╮
        -- │ Diagnostics navigation (Doom [ ] style)  │
        -- ╰─────────────────────────────────────────╯
        ["]e"] = { function() vim.diagnostic.goto_next() end, desc = "Next diagnostic" },
        ["[e"] = { function() vim.diagnostic.goto_prev() end, desc = "Previous diagnostic" },

      },

      v = {
        ["<Leader>ca"] = { function() vim.lsp.buf.code_action() end, desc = "Code action" },
        ["<Leader>/"] = { function() require("telescope.builtin").live_grep() end, desc = "Search project" },
      },

      t = {
        ["<C-\\>"] = { "<C-\\><C-n>", desc = "Exit terminal mode" },
      },
    },
  },
  config = function(_, opts)
    opts.diagnostics.jump = {
      on_jump = function(_, bufnr)
        vim.diagnostic.open_float { bufnr = bufnr, scope = "cursor", focus = false }
      end,
    }
    require("astrocore").setup(opts)
    vim.keymap.set("v", "<Leader>/", function() require("telescope.builtin").live_grep() end, {
      desc = "Search project",
    })
  end,
}
