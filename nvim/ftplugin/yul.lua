if vim.b.did_ftplugin then return end
vim.b.did_ftplugin = true

vim.bo.commentstring = "// %s"
vim.bo.comments = "s1:/*,mb:*,ex:*/,://"
vim.bo.expandtab = true
vim.bo.shiftwidth = 4
vim.bo.softtabstop = 4
vim.bo.autoindent = true
vim.bo.smartindent = true
vim.opt_local.iskeyword:append "."

vim.b.undo_ftplugin = "setlocal commentstring< comments< expandtab< shiftwidth< softtabstop< autoindent< smartindent< iskeyword<"
