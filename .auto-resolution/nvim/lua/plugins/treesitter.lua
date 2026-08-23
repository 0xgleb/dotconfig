-- Neovim 0.12 removed the `all = false` compatibility mode for query
-- predicates and directives: handlers now always receive `match` as a table
-- mapping capture ids to LISTS of nodes. The nvim-treesitter `master` branch
-- (frozen upstream, pinned by AstroNvim v5) still indexes `match` as if it
-- held single nodes, which crashes injection parsing with
-- "attempt to call method 'range' (a nil value)". Until AstroNvim moves to
-- the nvim-treesitter `main` rewrite, re-register those handlers with
-- 0.12-compatible implementations after the plugin has registered its own.

local html_script_type_languages = {
  importmap = "json",
  module = "javascript",
  ["application/ecmascript"] = "javascript",
  ["text/ecmascript"] = "javascript",
}

local injection_language_aliases = {
  ex = "elixir",
  pl = "perl",
  sh = "bash",
  uxn = "uxntal",
  ts = "typescript",
}

local function language_from_info_string(injection_alias)
  local filetype = vim.filetype.match { filename = "a." .. injection_alias }
  return filetype or injection_language_aliases[injection_alias] or injection_alias
end

local function captured_node(match, capture_id)
  local nodes = match[capture_id]
  if type(nodes) == "table" then return nodes[#nodes] end
  return nodes
end

local function register_nvim_0_12_query_handlers()
  local query = vim.treesitter.query

  query.add_predicate("nth?", function(match, _, _, pred)
    local node = captured_node(match, pred[2])
    local n = tonumber(pred[3])
    if node and node:parent() and node:parent():named_child_count() > n then
      return node:parent():named_child(n) == node
    end
    return false
  end, { force = true })

  query.add_predicate("is?", function(match, _, bufnr, pred)
    local node = captured_node(match, pred[2])
    if not node then return true end
    local locals = require "nvim-treesitter.locals"
    local _, _, kind = locals.find_definition(node, bufnr)
    return vim.tbl_contains({ unpack(pred, 3) }, kind)
  end, { force = true })

  query.add_predicate("kind-eq?", function(match, _, _, pred)
    local node = captured_node(match, pred[2])
    if not node then return true end
    return vim.tbl_contains({ unpack(pred, 3) }, node:type())
  end, { force = true })

  query.add_directive("set-lang-from-mimetype!", function(match, _, bufnr, pred, metadata)
    local node = captured_node(match, pred[2])
    if not node then return end
    local mimetype = vim.treesitter.get_node_text(node, bufnr)
    local configured = html_script_type_languages[mimetype]
    if configured then
      metadata["injection.language"] = configured
    else
      local parts = vim.split(mimetype, "/", {})
      metadata["injection.language"] = parts[#parts]
    end
  end, { force = true })

  query.add_directive("set-lang-from-info-string!", function(match, _, bufnr, pred, metadata)
    local node = captured_node(match, pred[2])
    if not node then return end
    local info_string = vim.treesitter.get_node_text(node, bufnr):lower()
    metadata["injection.language"] = language_from_info_string(info_string)
  end, { force = true })

  query.add_directive("downcase!", function(match, _, bufnr, pred, metadata)
    local capture_id = pred[2]
    local node = captured_node(match, capture_id)
    if not node then return end
    local text = vim.treesitter.get_node_text(node, bufnr, { metadata = metadata[capture_id] }) or ""
    if not metadata[capture_id] then metadata[capture_id] = {} end
    metadata[capture_id].text = string.lower(text)
  end, { force = true })
end

---@type LazySpec
return {
  {
    "nvim-treesitter/nvim-treesitter",
    opts = {
      ensure_installed = {},
      auto_install = false,
      highlight = { enable = false },
    },
    config = function(plugin, opts)
      require "astronvim.plugins.configs.nvim-treesitter"(plugin, opts)
      register_nvim_0_12_query_handlers()
    end,
  },
  {
    "folke/snacks.nvim",
    opts = {
      indent = { enabled = false },
      scope = { enabled = false },
    },
  },
}
