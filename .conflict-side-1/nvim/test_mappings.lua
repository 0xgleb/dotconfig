-- Test that all documented keybindings are registered and point to the right descriptions.
-- Run with: nvim --headless -c "luafile test_mappings.lua" -c "qa!"

local failed = 0
local passed = 0

local function assert_mapping(mode, lhs, expected_desc)
  local maps = vim.api.nvim_get_keymap(mode)
  for _, map in ipairs(maps) do
    if map.lhs == lhs or map.lhs == lhs:gsub("<Space>", " ") then
      if expected_desc and map.desc ~= expected_desc then
        print("FAIL: " .. mode .. " " .. lhs .. " desc=" .. (map.desc or "nil") .. " expected=" .. expected_desc)
        failed = failed + 1
        return
      end
      passed = passed + 1
      return
    end
  end
  print("FAIL: " .. mode .. " " .. lhs .. " not found (expected: " .. (expected_desc or "any") .. ")")
  failed = failed + 1
end

local function assert_no_mapping(mode, lhs)
  local maps = vim.api.nvim_get_keymap(mode)
  for _, map in ipairs(maps) do
    if map.lhs == lhs or map.lhs == lhs:gsub("<Space>", " ") then
      print("FAIL: " .. mode .. " " .. lhs .. " should be disabled but found desc=" .. (map.desc or map.rhs or "?"))
      failed = failed + 1
      return
    end
  end
  passed = passed + 1
end

-- Quick access
assert_mapping("n", " <Space>", "Find file in project")
assert_mapping("n", " /", "Search project")
assert_mapping("n", " ,", "Switch buffer")
assert_mapping("n", " :", "Command palette")
assert_mapping("n", " ;", "Enter command")
assert_mapping("n", " x", "Close buffer")
assert_mapping("n", " j", "Jump to word")
assert_mapping("n", "<M-x>", "Command palette")

-- Buffer
assert_mapping("n", " bb", "Switch buffer")
assert_mapping("n", " bk", "Kill buffer")
assert_mapping("n", " bd", "Kill buffer")
assert_mapping("n", " bn", "Next buffer")
assert_mapping("n", " bp", "Previous buffer")
assert_mapping("n", " br", "Revert buffer")
assert_mapping("n", " bs", "Save buffer")
assert_mapping("n", " bS", "Save all buffers")
assert_mapping("n", " bo", "Kill other buffers")

-- Code / LSP (SPC c must be disabled as a direct mapping)
assert_no_mapping("n", " c")
assert_mapping("n", " cd", "Go to definition")
assert_mapping("n", " cD", "Find references")
assert_mapping("n", " ca", "Code action")
assert_mapping("n", " cr", "Rename symbol")
assert_mapping("n", " cf", "Format buffer")
assert_mapping("n", " ci", "Go to implementation")
assert_mapping("n", " ck", "Hover documentation")
assert_mapping("n", " cs", "Signature help")
assert_mapping("n", " cx", "List errors")

-- File
assert_mapping("n", " ff", "Find file")
assert_mapping("n", " fr", "Recent files")
assert_mapping("n", " fs", "Save file")
assert_mapping("n", " fy", "Yank file path")
assert_mapping("n", " fY", "Yank absolute path")
assert_mapping("n", " fp", "Find config file")

-- Git
assert_mapping("n", " gg", "Git status (gitui)")
assert_mapping("n", " gb", "Git blame line")
assert_mapping("n", " gB", "Git blame buffer")
assert_mapping("n", " gd", "Git diff")
assert_mapping("n", " gp", "Preview hunk")
assert_mapping("n", " gr", "Reset hunk")
assert_mapping("n", " gR", "Reset buffer")
assert_mapping("n", " gS", "Stage hunk")
assert_mapping("n", " gU", "Unstage hunk")

-- Help
assert_mapping("n", " hk", "Describe keybindings")
assert_mapping("n", " hh", "Help tags")
assert_mapping("n", " hm", "Man pages")
assert_mapping("n", " ht", "Change theme")

-- Open
assert_mapping("n", " on", "File tree")
assert_mapping("n", " oN", "File tree (reveal current)")
assert_mapping("n", " op", "Project sidebar")
assert_mapping("n", " ot", "Terminal")

-- Project
assert_mapping("n", " pf", "Search project")
assert_mapping("n", " pr", "Recent project files")
assert_mapping("n", " pp", "Switch project")

-- Search
assert_mapping("n", " ss", "Search buffer")
assert_mapping("n", " sS", "Search buffer (word at point)")
assert_mapping("n", " sp", "Search project")
assert_mapping("n", " sP", "Search project (word at point)")
assert_mapping("n", " sd", "Search directory")
assert_mapping("n", " sb", "Search buffers")
assert_mapping("n", " si", "Search symbols")
assert_mapping("n", " sI", "Search symbols (workspace)")
assert_mapping("n", " sr", "Resume last search")

-- Toggle
assert_mapping("n", " tl", "Toggle line numbers")
assert_mapping("n", " tw", "Toggle word wrap")
assert_mapping("n", " ts", "Toggle spell check")
assert_mapping("n", " tf", "Toggle format on save")
assert_mapping("n", " td", "Toggle diagnostics")

-- Window
assert_mapping("n", " wh", "Window left")
assert_mapping("n", " wj", "Window down")
assert_mapping("n", " wk", "Window up")
assert_mapping("n", " wl", "Window right")
assert_mapping("n", " ws", "Horizontal split")
assert_mapping("n", " wv", "Vertical split")
assert_mapping("n", " wc", "Close window")
assert_mapping("n", " wd", "Close window")
assert_mapping("n", " wq", "Quit window")
assert_mapping("n", " ww", "Next window")
assert_mapping("n", " wW", "Previous window")
assert_mapping("n", " wo", "Only window")
assert_mapping("n", " wm", "Maximize window")
assert_mapping("n", " w=", "Balance windows")

-- Quit
assert_mapping("n", " qq", "Quit")
assert_mapping("n", " qQ", "Quit without saving")
assert_mapping("n", " qs", "Save and quit")
assert_mapping("n", " qd", "Dashboard")

-- Diagnostics
assert_mapping("n", "]e", "Next diagnostic")
assert_mapping("n", "[e", "Previous diagnostic")

-- Terminal mode
assert_mapping("t", "<C-Bslash>", "Exit terminal mode")

-- Visual mode
assert_mapping("v", " ca", "Code action")
assert_mapping("v", " /", "Search project")

print("")
print(passed .. " passed, " .. failed .. " failed")
if failed > 0 then
  vim.cmd("cq")
end
