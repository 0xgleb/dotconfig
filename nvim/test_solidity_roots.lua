local fixture = vim.fn.getcwd() .. "/.tmp/solidity-lsp-" .. vim.fn.getpid()
local root = fixture .. "/.worktrees/project"
local function write(path, lines)
  vim.fn.mkdir(vim.fs.dirname(root .. "/" .. path), "p")
  vim.fn.writefile(lines, root .. "/" .. path)
end
write("foundry.toml", { "[profile.default]", "src = 'attack/contracts'", "libs = ['lib']" })
write("remappings.txt", { "@example/=lib/example/", "legacy/=lib/legacy/" })
write("lib/dependency/foundry.toml", { "[profile.default]", "src = 'src'" })
local header = { "// SPDX-License-Identifier: MIT", "pragma solidity ^0.8.20;" }
write("lib/dependency/src/Dependency.sol", vim.list_extend(vim.deepcopy(header), { "contract Dependency {}" }))
write("lib/example/Example.sol", vim.list_extend(vim.deepcopy(header), { "library Example {}" }))
write("attack/contracts/EditorImportProbe.sol", vim.list_extend(vim.deepcopy(header), {
  'import {Example} from "@example/Example.sol";',
  'contract EditorImportProbe { uint256 value = "not a number"; }',
}))
local legacy_header = { "// SPDX-License-Identifier: MIT", "pragma solidity <0.7.0;" }
write("lib/legacy/Legacy.sol", vim.list_extend(vim.deepcopy(legacy_header), { "library Legacy {}" }))
write("attack/contracts/LegacyProbe.sol", vim.list_extend(vim.deepcopy(legacy_header), {
  'import "legacy/Legacy.sol";',
  'contract LegacyProbe { uint256 value = "not a number"; }',
}))
root = assert(vim.uv.fs_realpath(root))
local ok, err = xpcall(function()
  if vim.env.SOLIDITY_TEST_FORGE_BIN then
    vim.env.PATH = vim.env.SOLIDITY_TEST_FORGE_BIN .. ":" .. vim.env.PATH
  end
  assert(vim.fn.executable "forge" == 1, "Run with forge on PATH")
  require("lazy").load { plugins = { "nvim-lspconfig" } }
  local name = "solidity_ls_nomicfoundation"
  local function open(path)
    vim.cmd.edit(path)
    local bufnr = vim.api.nvim_get_current_buf()
    assert(vim.wait(20000, function()
      local client = vim.lsp.get_clients { name = name, bufnr = bufnr }[1]
      return client and client.initialized
    end), "Solidity client did not initialize")
    return bufnr, vim.lsp.get_clients({ name = name, bufnr = bufnr })[1]
  end
  local _, dependency = open(root .. "/lib/dependency/src/Dependency.sol")
  local bufnr, project = open(root .. "/attack/contracts/EditorImportProbe.sol")
  assert(dependency.id ~= project.id, "Distinct Foundry roots share one Solidity client")
  assert(project.config.root_dir == root, "Main file attached to the dependency root")
  local function check_imports_and_diagnostics(bufnr)
    assert(vim.wait(20000, function()
      for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
        if tostring(diagnostic.code) == "7407" then return true end
      end
      return false
    end), "Expected compiler type error was not reported: " .. vim.inspect(vim.diagnostic.get(bufnr)))
    for _, diagnostic in ipairs(vim.diagnostic.get(bufnr)) do
      assert(tostring(diagnostic.code) ~= "6275", "Foundry remapped import was not resolved")
    end
  end
  check_imports_and_diagnostics(bufnr)
  local legacy_bufnr, legacy_client = open(root .. "/attack/contracts/LegacyProbe.sol")
  assert(legacy_client.id == project.id, "Same Foundry root should reuse its client")
  check_imports_and_diagnostics(legacy_bufnr)
end, debug.traceback)
for _, client in ipairs(vim.lsp.get_clients { name = "solidity_ls_nomicfoundation" }) do client:stop(true) end
vim.fn.delete(fixture, "rf")
if not ok then
  io.stderr:write(err .. "\n")
  vim.cmd "cquit 1"
end
print "Nested Foundry roots stay separate; modern and legacy imports resolve with compiler errors preserved"
