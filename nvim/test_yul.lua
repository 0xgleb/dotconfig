local ok, err = xpcall(function()
  vim.cmd.enew()
  vim.cmd.file('LanguageSupport.yul')
  vim.cmd('filetype detect')
  assert(vim.bo.filetype == 'yul', '.yul filetype detection missing')
  vim.api.nvim_buf_set_lines(0, 0, -1, false, {
    'object "Example" {',
    'code {',
    'let x := mload(0x40)',
    '// mstore(0, 42)',
    '/* comment',
    'mstore(0, 42) */',
    'let text := "mstore // string"',
    'custom.fn(x)',
    '}',
    '}',
  })
  vim.cmd('syntax sync fromstart')
  local function group(line, column)
    return vim.fn.synIDattr(vim.fn.synID(line, column, 1), 'name')
  end
  assert(group(1, 1) == 'yulKeyword', 'object keyword not highlighted')
  assert(group(1, 8) == 'yulString', 'object name not highlighted')
  assert(group(3, 10) == 'yulBuiltin', 'mload not highlighted')
  assert(group(3, 16) == 'yulNumber', 'hex literal not highlighted')
  assert(group(4, 4) == 'yulComment', 'line comment not highlighted')
  assert(group(6, 1) == 'yulComment', 'multiline comment not highlighted')
  assert(group(7, 14) == 'yulString', 'string parsed as code/comment')
  assert(group(8, 1) == 'yulFunction', 'dotted function not highlighted')
  assert(vim.bo.commentstring == '// %s', 'comment integration missing')
  assert(vim.bo.expandtab and vim.bo.shiftwidth == 4, 'indent options missing')
  vim.cmd('normal! gg=G')
  assert(vim.fn.indent(2) == 4 and vim.fn.indent(3) == 8, 'nested block indentation failed')
  assert(vim.fn.indent(9) == 4 and vim.fn.indent(10) == 0, 'closing brace indentation failed')
  vim.bo.filetype = 'lua'
  assert(vim.bo.commentstring ~= '// %s', 'Yul settings leak on filetype change')
end, debug.traceback)
if not ok then
  io.stderr:write(err .. '\n')
  vim.cmd('cquit 1')
end
print('Yul detection, syntax, indentation, comments, and filetype cleanup passed')
