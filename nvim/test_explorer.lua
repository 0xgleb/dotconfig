-- Run: nvim --headless -i NONE -c "luafile nvim/test_explorer.lua"
local fixture
local restore_observers

local function run()
  local api, uv = vim.api, vim.uv
  local function git(...)
    local result = vim.system({ 'git', ... }, { text = true }):wait()
    assert(result.code == 0, result.stderr)

    return vim.trim(result.stdout)
  end

  fixture = vim.fn.tempname()
  vim.fn.mkdir(fixture .. '/main', 'p')
  local main = uv.fs_realpath(fixture .. '/main')
  local worktree = main .. '/.worktrees/active'
  vim.fn.writefile({ 'return 1' }, main .. '/one.lua')
  vim.fn.writefile({ 'return 2' }, main .. '/two.lua')
  vim.fn.writefile({ '.worktrees/' }, main .. '/.gitignore')
  git('init', main)
  git('-C', main, 'add', '.')
  git('-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
  git('-C', main, 'worktree', 'add', '-b', 'active', worktree)

  vim.cmd.cd(main)
  vim.cmd.edit(worktree .. '/one.lua')
  vim.wait(500)
  local mapping = vim.fn.maparg('<Leader>on', 'n', false, true)
  if mapping.callback then mapping.callback() else vim.cmd(mapping.rhs:match('<Cmd>(.-)<CR>')) end
  local manager = require('neo-tree.sources.manager')

  assert(vim.wait(1000, function()
    local state = manager.get_state('filesystem')
    return state.tree ~= nil and state.tree:get_node(worktree .. '/two.lua') ~= nil
  end), 'Explorer did not list worktree fixture two.lua')

  local state = manager.get_state('filesystem')
  assert(state.path == worktree, 'Explorer used ' .. tostring(state.path) .. ' instead of active worktree ' .. worktree)
  assert(require('neo-tree').config.filesystem.async_directory_scan == 'always', 'Command scans still block')
  assert(not state.use_libuv_file_watcher, 'Explorer still starts native directory watchers')

  vim.cmd.wincmd('p')
  vim.cmd.edit(worktree .. '/two.lua')
  assert(vim.wait(3000, function() return require('gitsigns.cache').cache[api.nvim_get_current_buf()] ~= nil end), 'Gitsigns did not attach')

  local signs = require('gitsigns')
  local async = require('gitsigns.async')
  local original_arun, original_change_base = async.arun, signs.change_base
  local observed = { refresh = 0, change_base = 0 }
  local pending = 0
  local task_errors = {}
  local function observe(task, operation)
    assert(type(task) == 'table' and type(task.await) == 'function', 'Gitsigns did not return an async task')
    observed[operation] = observed[operation] + 1
    pending = pending + 1
    task:await(function(err)
      pending = pending - 1
      if err ~= nil then task_errors[#task_errors + 1] = tostring(err) end
    end)

    return task
  end

  restore_observers = function()
    async.arun = original_arun
    signs.change_base = original_change_base
  end
  async.arun = function(...) return observe(original_arun(...), 'refresh') end
  signs.change_base = function(...) return observe(original_change_base(...), 'change_base') end

  local buf = api.nvim_get_current_buf()
  local first = vim.fn.bufnr(worktree .. '/one.lua')
  api.nvim_buf_call(first, function() signs.change_base('HEAD') end)

  assert(vim.wait(3000, function()
    return require('gitsigns.cache').cache[first].git_obj.revision == 'HEAD'
  end), 'Custom comparison base was not set')

  api.nvim_buf_set_lines(buf, 0, -1, false, { 'return 3' })
  vim.cmd.write()
  git('-C', worktree, 'add', 'two.lua')
  local staged = git('-C', worktree, 'rev-parse', ':two.lua')
  git('-C', worktree, 'branch', '-m', 'renamed')
  vim.v.errmsg = '' -- Capture errors from the refresh/reload/close sequence.
  api.nvim_exec_autocmds('FocusGained', {})
  -- External reload while the asynchronous refresh is in flight must keep
  -- Gitsigns' buffer callbacks attached to a live cache entry.
  vim.fn.writefile({ 'return 4' }, api.nvim_buf_get_name(buf))
  vim.o.autoread = true
  vim.cmd.checktime()

  assert(api.nvim_buf_get_lines(buf, 0, -1, false)[1] == 'return 4', 'External reload did not run')
  assert(vim.wait(3000, function()
    local entry = require('gitsigns.cache').cache[buf]
    return entry and entry.git_obj.object_name == staged and vim.b[buf].gitsigns_head == 'renamed'
  end), 'External Git refresh left a stale index or branch name')
  assert(require('gitsigns.cache').cache[first].git_obj.revision == 'HEAD', 'Refresh reset a custom comparison base')

  -- Repeated refreshes and closing while Git IO is pending must not detach
  -- callbacks or leave delayed errors after the buffer is gone.
  local refreshes_before_close = observed.refresh
  for _ = 1, 3 do api.nvim_exec_autocmds('FocusGained', {}) end

  assert(observed.refresh > refreshes_before_close, 'Close regression did not start refresh tasks')
  assert(pending > 0, 'Close regression did not overlap pending Git IO')

  local close_started = uv.hrtime()
  require('astrocore.buffer').close()
  local close_ms = (uv.hrtime() - close_started) / 1e6

  assert(close_ms < 500, ('Buffer close blocked for %.0fms'):format(close_ms))
  assert(vim.wait(200, function() return pending == 0 end), 'Gitsigns tasks did not finish after close')
  assert(observed.change_base > 0, 'Comparison tasks were not observed')
  assert(#task_errors == 0, 'Gitsigns async task errors: ' .. table.concat(task_errors, '\n'))
  assert(vim.v.errmsg == '', 'Delayed callback error: ' .. vim.v.errmsg)

  local messages = api.nvim_exec2('messages', { output = true }).output
  assert(not messages:find('assertion failed', 1, true), messages)

  print(('PASS: active worktree nodes, async tasks, and buffer close %.1fms'):format(close_ms))
  require('neo-tree.command').execute({ action = 'close' })
end

vim.defer_fn(function()
  local ok, err = xpcall(run, debug.traceback)
  if restore_observers then restore_observers() end
  vim.cmd.cd('/tmp')
  local cleaned = not fixture or vim.fn.delete(fixture, 'rf') == 0

  if not ok or not cleaned then
    print(not ok and err or 'Failed to clean explorer fixture')
    vim.cmd('cquit 1')
  else
    vim.cmd('qa!')
  end
end, 100)
