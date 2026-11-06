-- Run via: python3 nvim/test_rust_exit.py
local function run()
  local root = vim.g.quit_fixture_root
  require('lazy').load { plugins = { 'nvim-lspconfig' } }
  vim.cmd.edit(root .. '/src/main.rs')
  local config = vim.tbl_deep_extend('force', {}, require('lspconfig').rust_analyzer.manager.config, { root_dir = root })
  local id = assert(vim.lsp.start(config))
  assert(vim.wait(20000, function()
    local client = vim.lsp.get_client_by_id(id)
    return client and client.initialized
  end), 'Rust LSP did not initialize')
  require('vim.lsp._watchfiles').register({
    id = 'rust-quit-regression',
    method = 'workspace/didChangeWatchedFiles',
    registerOptions = { watchers = { { globPattern = { baseUri = vim.uri_from_fname(root), pattern = '**/*.rs' }, kind = 7 } } },
  }, id)
  local active = 0
  vim.uv.walk(function(h)
    if tostring(h):find('fs_event') and h:is_active() and vim.uv.fs_event_getpath(h) == root then
      active = active + 1
    end
  end)
  assert(active == 0, 'Rust registered native directory watchers inside Neovim; these can block shutdown')
  assert(config.settings['rust-analyzer'].files.watcher == 'server', 'Rust file watching must run in the server process')
  vim.defer_fn(function()
    vim.api.nvim_create_autocmd('VimLeavePre', { callback = function() require('vim.lsp._watchfiles').cancel(id) end })
    local sec, usec = vim.uv.gettimeofday()
    print(('QUIT_START %.6f'):format(sec + usec / 1e6))
    vim.cmd('qa!')
  end, 200)
end
vim.defer_fn(function()
  local ok, err = xpcall(run, debug.traceback)
  if not ok then print(err); vim.cmd('cquit 1') end
end, 100)
