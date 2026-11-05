-- Canonical ipynb files, a Markdown view, and revision-checked local edits.
-- Jupytext owns conversion; Molten owns execution. Neither is reimplemented.
local M = {}
local states = {}
local shared_root
local ready_kernels = {}
local api = vim.api

local function read(path)
  local file = assert(io.open(path, "rb"), "Cannot read " .. path)
  local content = file:read "*a"
  file:close()
  return content
end

local function write(path, content)
  local file = assert(io.open(path, "wb"), "Cannot write " .. path)
  assert(file:write(content))
  assert(file:close())
end

local function source(buf) return table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), "\n") end
local function json(path) return vim.json.decode(read(path)) end
local function normalized(text)
  if type(text) == "table" then text = table.concat(text) end
  return (text:gsub("\n+$", ""))
end

local function command(name, args, bang) vim.cmd { cmd = name, args = args or {}, bang = bang or false } end
local function convert(args, stdin)
  local result = vim.system(vim.list_extend({ "jupytext" }, args), { text = true, stdin = stdin }):wait()
  assert(result.code == 0, "Jupytext conversion failed: " .. result.stderr)
  return result.stdout
end

local function temporary(callback)
  local dir = vim.fn.tempname()
  assert(vim.fn.mkdir(dir, "p", 448) == 1)
  local ok, result = xpcall(function() return callback(dir) end, debug.traceback)
  vim.fn.delete(dir, "rf")
  assert(ok, result)
  return result
end

local function kernels()
  -- Remote functions may be registered lazily, so exists('*...') can be false
  -- before the first call even though Molten is installed.
  local ok, active = pcall(vim.fn.MoltenRunningKernels, true)
  if not ok then return {} end
  return active
end

local function dump(kernel)
  return temporary(function(dir)
    local path = dir .. "/molten.json"
    command("MoltenSave", { path, kernel })
    return json(path).cells
  end)
end

local function idle(cells)
  for _, cell in ipairs(cells) do
    assert(
      cell.status ~= 0 and cell.status ~= 1,
      "Cell execution pending; wait for completion before saving or running another cell"
    )
  end
end

local function signature(cell)
  return { count = cell.execution_count, status = cell.status, success = cell.success, chunks = cell.chunks }
end

-- Strict, unindented Haskell fences are the notebook edit format. Conversion
-- validates these spans against Jupytext's code cells before any output export.
local function fences(buf)
  local lines = api.nvim_buf_get_lines(buf, 0, -1, false)
  local cells = {}
  local opening, delimiter
  for row, line in ipairs(lines) do
    if not opening then
      local marks, info = line:match "^([`~]+)(.*)$"
      if marks and #marks >= 3 and (marks:match "^`+$" or marks:match "^~+$") then
        assert(
          info:match "^%s*haskell%s*$" or info:match "^%s*haskell%s+",
          "Notebook code fences must use haskell: " .. line
        )
        opening, delimiter = row, marks
      end
    elseif line:match("^" .. delimiter .. delimiter:sub(1, 1) .. "*%s*$") then
      assert(row > opening + 1, "Empty code fences are unsupported; remove the cell or add code")
      local content = table.concat(vim.list_slice(lines, opening + 1, row - 1), "\n")
      cells[#cells + 1] =
        { first = opening, last = row - 2, ending = #lines[row - 1], source = content, fence = lines[opening] }
      opening, delimiter = nil, nil
    end
  end
  assert(not opening, "Unclosed notebook code fence")
  return cells
end

local function discard_stale(state, kernel)
  if not state.stale then return end
  idle(dump(kernel))
  command("MoltenDelete", {}, true)
  assert(#dump(kernel) == 0, "Could not clear old output associations")
  state.baseline = {}
  state.executed = {}
  state.stale = false
end

local function mapped_cells(notebook, buf)
  local spans, code_cells = fences(buf), {}
  for index, cell in ipairs(notebook.cells) do
    if cell.cell_type == "code" then code_cells[#code_cells + 1] = index end
  end
  assert(#spans == #code_cells, "Code cell mapping disagrees with Jupytext")
  for index, span in ipairs(spans) do
    assert(
      normalized(notebook.cells[code_cells[index]].source) == normalized(span.source),
      "Code cell source disagrees with Jupytext"
    )
  end
  return spans, code_cells
end

local function import_outputs(state, kernel, buf)
  local notebook = vim.json.decode(state.disk)
  local spans, indexes = mapped_cells(notebook, buf)
  -- Anchor Molten's sequential text matcher at the opening fence. A prose line
  -- equal to a code cell can no longer steal its output. Execution still uses
  -- only the code inside the fence; no buffer text or undo history is changed.
  local projection = vim.deepcopy(notebook)
  projection.cells = {}
  for index, span in ipairs(spans) do
    local cell = vim.deepcopy(notebook.cells[indexes[index]])
    cell.source = span.fence .. "\n" .. span.source
    projection.cells[#projection.cells + 1] = cell
  end
  temporary(function(dir)
    local path = dir .. "/import.ipynb"
    write(path, vim.json.encode(projection))
    command("MoltenImportOutput", { path })
  end)
  local imported = dump(kernel)
  assert(#imported == #spans, "Incomplete notebook output import")
  table.sort(imported, function(left, right) return left.span.begin.lineno < right.span.begin.lineno end)
  for index, cell in ipairs(imported) do
    local span = spans[index]
    assert(
      cell.span.begin.lineno == span.first - 1
        and cell.span.begin.colno == 0
        and cell.span["end"].lineno == span.last
        and cell.span["end"].colno == span.ending,
      "Molten imported output outside its code fence"
    )
    state.baseline[tostring(cell.span.begin.lineno)] = signature(cell)
  end
end

local function export_outputs(notebook, state, kernel, buf, dir)
  local cells = dump(kernel)
  idle(cells)
  if #cells == 0 then return end
  local spans, code_cells = mapped_cells(notebook, buf)
  table.sort(cells, function(left, right) return left.span.begin.lineno < right.span.begin.lineno end)
  local projection, targets = vim.deepcopy(notebook), {}
  projection.cells = {}
  local marker = "research-output-export-pending"
  for _, live in ipairs(cells) do
    local found
    for index, span in ipairs(spans) do
      if
        (live.span.begin.lineno == span.first or live.span.begin.lineno == span.first - 1)
        and live.span.begin.colno == 0
        and live.span["end"].lineno == span.last
        and live.span["end"].colno == span.ending
      then
        found = code_cells[index]
        break
      end
    end
    assert(found, "Only complete notebook cells can be saved; use :NotebookRun")
    local cell = vim.deepcopy(notebook.cells[found])
    cell.source =
      table.concat(api.nvim_buf_get_lines(buf, live.span.begin.lineno, live.span["end"].lineno + 1, false), "\n")
    cell.outputs = { { output_type = "stream", name = "stdout", text = marker } }
    projection.cells[#projection.cells + 1] = cell
    targets[#targets + 1] = found
  end
  local path = dir .. "/projection.ipynb"
  write(path, vim.json.encode(projection))
  command("MoltenExportOutput", { path, kernel }, true)
  local exported = json(path)
  assert(#exported.cells == #cells, "Incomplete Molten output export")
  for index, live in ipairs(cells) do
    local result = exported.cells[index]
    assert(not vim.json.encode(result.outputs):find(marker, 1, true), "Molten output export failed")
    assert(result.execution_count == live.execution_count, "Execution count changed during export; save again")
    -- Preserve original MIME/error/stream representations for untouched imports.
    local row = tostring(live.span.begin.lineno)
    if state.executed[row] or not vim.deep_equal(state.baseline[row], signature(live)) then
      notebook.cells[targets[index]].outputs = result.outputs
      notebook.cells[targets[index]].execution_count = result.execution_count
    end
  end
end

function M.save(buf)
  local state = assert(states[buf], "Not a notebook buffer")
  assert(not vim.bo[buf].readonly, "Notebook is read-only")
  assert(read(state.path) == state.disk, "Notebook changed on disk; refusing to overwrite it")
  local tick = api.nvim_buf_get_changedtick(buf)
  local active = kernels()
  assert(#active <= 1, "A notebook must use exactly one kernel")
  if active[1] then discard_stale(state, active[1]) end
  temporary(function(dir)
    local target = dir .. "/notebook.ipynb"
    write(target, state.disk)
    convert({ "--from", "md", "--to", "ipynb", "--update", "--output", target, "-" }, source(buf) .. "\n")
    local notebook = json(target)
    if state.invalidated then
      for _, cell in ipairs(notebook.cells) do
        if cell.cell_type == "code" then
          cell.outputs, cell.execution_count = {}, vim.NIL
        end
      end
    end
    if active[1] then export_outputs(notebook, state, active[1], buf, dir) end
    write(target, vim.json.encode(notebook))
    local checked = vim
      .system(
        { "python", "-c", "import nbformat,sys; nbformat.validate(nbformat.read(sys.argv[1], as_version=4))", target },
        { text = true }
      )
      :wait()
    assert(checked.code == 0, "Invalid notebook: " .. checked.stderr)
    assert(api.nvim_buf_get_changedtick(buf) == tick, "Buffer changed while saving; retry")
    assert(read(state.path) == state.disk, "Notebook changed on disk while saving; refusing to overwrite it")
    local content = read(target)
    -- A sibling temporary file allows an atomic rename on the same filesystem.
    local sibling = state.path .. "." .. vim.fn.getpid() .. ".tmp"
    assert(not vim.uv.fs_lstat(sibling), "Notebook temporary path already exists")
    local ok, err = pcall(function()
      write(sibling, content)
      assert(vim.uv.fs_chmod(sibling, assert(vim.uv.fs_stat(state.path)).mode % 512))
      assert(vim.uv.fs_rename(sibling, state.path))
    end)
    if not ok then
      vim.uv.fs_unlink(sibling)
      error(err)
    end
    state.disk = content
    state.invalidated, state.stale = false, false
    vim.bo[buf].modified = false
  end)
end

function M.init()
  local buf = api.nvim_get_current_buf()
  local state = assert(states[buf], "Open a notebook first")
  assert(#kernels() == 0, "Notebook already has a kernel")
  ready_kernels = {}
  state.baseline, state.executed = {}, {}
  vim.b[buf].research_kernel_ready = false
  command("MoltenInit", { "yielduck-haskell" })
  local active = kernels()
  assert(#active == 1, "IHaskell failed to initialize")
  state.kernel_id = active[1]
  vim.b[buf].research_kernel_ready = ready_kernels[active[1]] or false
  if not state.invalidated then import_outputs(state, active[1], buf) end
end

function M.run()
  local buf = api.nvim_get_current_buf()
  local state = assert(states[buf], "Open a notebook first")
  local active = kernels()
  assert(#active == 1, "Start the notebook kernel with :NotebookInit")
  assert(vim.b[buf].research_kernel_ready, "IHaskell is starting; wait for the kernel-ready notification")
  discard_stale(state, active[1])
  idle(dump(active[1]))
  local row = api.nvim_win_get_cursor(0)[1] - 1
  for _, cell in ipairs(fences(buf)) do
    if row >= cell.first and row <= cell.last then
      state.executed[tostring(cell.first)] = true
      vim.bo[buf].modified = true
      vim.fn.MoltenEvaluateRange(active[1], cell.first + 1, cell.last + 1, 1, cell.ending + 1)
      return
    end
  end
  error "Place the cursor inside a Haskell code cell"
end

local function open(buf, path)
  api.nvim_exec_autocmds("BufReadPre", { buffer = buf, modeline = false })
  path = assert(vim.uv.fs_realpath(path), "Create a notebook from workflow.ipynb first")
  local content = read(path)
  local text = convert({ "--from", "ipynb", "--to", "md", "--output", "-", "-" }, content)
  api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text:gsub("\n$", ""), "\n", { plain = true }))
  vim.bo[buf].filetype = "markdown"
  vim.bo[buf].modified = false
  states[buf] = { path = path, disk = content, baseline = {}, executed = {}, stale = false, invalidated = false }
  api.nvim_buf_attach(buf, false, {
    on_lines = function()
      local state = states[buf]
      if state then
        state.stale, state.invalidated = true, true
      end
    end,
    on_detach = function() states[buf] = nil end,
  })
  local function mapping(lhs, callback, desc) vim.keymap.set("n", lhs, callback, { buffer = buf, desc = desc }) end
  mapping("<LocalLeader>mi", M.init, "Initialize notebook")
  mapping("<LocalLeader>r", M.run, "Run notebook cell")
  vim.keymap.set("x", "<LocalLeader>r", "<Esc><Cmd>NotebookRun<CR>", { buffer = buf, desc = "Run notebook cell" })
  mapping("<LocalLeader>mr", M.run, "Run notebook cell")
  mapping("<LocalLeader>ml", M.run, "Run notebook cell")
  mapping("<LocalLeader>ms", function() M.share(vim.fn.getcwd()) end, "Share research buffers")
  api.nvim_exec_autocmds("BufReadPost", { buffer = buf, modeline = false })
  -- Normal extension detection sees .ipynb and selects JSON during BufReadPost.
  -- Restore the virtual view's type after those standard reader hooks finish.
  vim.bo[buf].filetype = "markdown"
end

function M.share(root)
  root = assert(vim.uv.fs_realpath(root), "Research directory does not exist")
  assert(vim.uv.fs_stat(root .. "/.envrc"), "Share from the research directory containing .envrc")
  local directory = root .. "/.direnv"
  vim.fn.mkdir(directory, "p", 448)
  assert(not vim.uv.fs_lstat(directory).type:match "link", "Socket directory cannot be a symlink")
  local socket = directory .. "/research.sock"
  for _, address in ipairs(vim.fn.serverlist()) do
    if address == socket then
      shared_root = root
      return socket
    end
  end
  assert(not vim.uv.fs_lstat(socket), "Research socket already exists; use its owning Neovim session")
  vim.fn.serverstart(socket)
  assert(vim.uv.fs_chmod(socket, 384))
  shared_root = root
  vim.notify("Research editor socket: " .. socket)
  return socket
end

local function position(text, offset)
  local prefix = text:sub(1, offset)
  local _, row = prefix:gsub("\n", "")
  return row, #(prefix:match "[^\n]*$")
end

-- This endpoint deliberately has no save, execute, reload, or arbitrary Lua op.
function M.request(request)
  local ok, result = pcall(function()
    assert(shared_root, "Run :NotebookShare in the research editor first")
    local path = assert(vim.uv.fs_realpath(request.path), "File does not exist")
    assert(path:sub(1, #shared_root + 1) == shared_root .. "/", "File is outside shared research directory")
    assert(path:match "%.ipynb$" or path:match "%.hs$", "Only notebooks and Haskell modules are shared")
    local buf
    for _, candidate in ipairs(api.nvim_list_bufs()) do
      if api.nvim_buf_is_loaded(candidate) and vim.uv.fs_realpath(api.nvim_buf_get_name(candidate)) == path then
        buf = candidate
        break
      end
    end
    assert(buf, "File is not loaded in this Neovim; edit closed files on disk")
    assert(not path:match "%.ipynb$" or states[buf], "Notebook is not open in the Markdown adapter")
    local text = source(buf)
    if request.op == "patch" then
      assert(not vim.bo[buf].readonly and vim.bo[buf].modifiable, "Buffer is read-only")
      assert(
        type(request.changedtick) == "number" and request.changedtick == api.nvim_buf_get_changedtick(buf),
        "Revision conflict; read the buffer again"
      )
      assert(
        type(request.old) == "string" and #request.old > 0 and type(request.new) == "string",
        "Patch needs nonempty old and string new fragments"
      )
      local first, last = text:find(request.old, 1, true)
      assert(first and not text:find(request.old, first + 1, true), "Old fragment must occur exactly once")
      local start_row, start_col = position(text, first - 1)
      local end_row, end_col = position(text, last)
      api.nvim_buf_call(buf, function()
        -- Break the previous undo block so one undo removes only this patch.
        vim.cmd "let &undolevels = &undolevels"
        api.nvim_buf_set_text(
          buf,
          start_row,
          start_col,
          end_row,
          end_col,
          vim.split(request.new, "\n", { plain = true })
        )
      end)
      if path:match "%.hs$" then
        for _, state in pairs(states) do
          state.stale, state.invalidated = true, true
        end
      end
    else
      assert(request.op == "read", "Unknown research edit operation")
    end
    return {
      ok = true,
      path = path,
      source = source(buf),
      changedtick = api.nvim_buf_get_changedtick(buf),
      modified = vim.bo[buf].modified,
    }
  end)
  if ok then return result end
  return { ok = false, error = tostring(result) }
end

function M.setup()
  vim.filetype.add {
    extension = {
      ipynb = function(_, buf) return states[buf] and "markdown" or "json" end,
    },
  }
  local group = api.nvim_create_augroup("ResearchNotebook", { clear = true })
  api.nvim_create_autocmd("User", {
    group = group,
    pattern = "MoltenKernelReady",
    callback = function(event)
      local kernel = event.data and event.data.kernel_id
      if not kernel then return end
      ready_kernels[kernel] = true
      for buf, state in pairs(states) do
        if state.kernel_id == kernel then vim.b[buf].research_kernel_ready = true end
      end
    end,
  })
  api.nvim_create_autocmd(
    "BufReadCmd",
    { group = group, pattern = "*.ipynb", callback = function(event) open(event.buf, event.file) end }
  )
  api.nvim_create_autocmd("BufWritePost", {
    group = group,
    pattern = "*.hs",
    callback = function()
      for _, state in pairs(states) do
        state.stale, state.invalidated = true, true
      end
    end,
  })
  api.nvim_create_autocmd("BufWriteCmd", {
    group = group,
    pattern = "*.ipynb",
    callback = function(event)
      local state = assert(states[event.buf], "Notebook is not loaded")
      assert(vim.uv.fs_realpath(event.file) == state.path, "Use a filesystem copy to create another notebook")
      api.nvim_exec_autocmds("BufWritePre", { buffer = event.buf, modeline = false })
      M.save(event.buf)
      api.nvim_exec_autocmds("BufWritePost", { buffer = event.buf, modeline = false })
    end,
  })
  api.nvim_create_user_command("NotebookInit", M.init, { force = true })
  api.nvim_create_user_command("NotebookRun", M.run, { force = true })
  api.nvim_create_user_command(
    "NotebookShare",
    function(event) M.share(event.args ~= "" and event.args or vim.fn.getcwd()) end,
    { nargs = "?", complete = "dir", force = true }
  )
end

return M
