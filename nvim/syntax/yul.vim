" Standalone Yul, including the EVM dialect and object notation.
" Language reference: https://docs.soliditylang.org/en/latest/yul.html
if exists('b:current_syntax')
  finish
endif

syntax case match
syntax match yulFunction /\<[a-zA-Z_$][a-zA-Z0-9_$.]*\ze\s*(/
syntax keyword yulKeyword object code data let function leave
syntax keyword yulConditional if switch case default
syntax keyword yulRepeat for break continue
syntax keyword yulBoolean true false
syntax match yulOperator /:=\|->/
syntax match yulNumber /\<\d\+\>/
syntax match yulNumber /\<0x[0-9a-fA-F]\+\>/

syntax keyword yulBuiltin stop add sub mul div sdiv mod smod exp not lt gt slt sgt eq iszero
syntax keyword yulBuiltin and or xor byte shl shr sar addmod mulmod signextend keccak256
syntax keyword yulBuiltin pop mload mstore mstore8 msize mcopy sload sstore tload tstore
syntax keyword yulBuiltin address balance selfbalance caller callvalue calldataload calldatasize calldatacopy
syntax keyword yulBuiltin codesize codecopy extcodesize extcodecopy extcodehash returndatasize returndatacopy
syntax keyword yulBuiltin create create2 call callcode delegatecall staticcall return revert selfdestruct invalid
syntax keyword yulBuiltin log0 log1 log2 log3 log4 chainid basefee blobbasefee blobhash origin gasprice
syntax keyword yulBuiltin blockhash coinbase timestamp number difficulty prevrandao gaslimit gas pc
syntax keyword yulBuiltin datacopy dataoffset datasize setimmutable loadimmutable linkersymbol memoryguard
syntax match yulBuiltin /\<verbatim_\d\+i_\d\+o\>/

syntax region yulString start=/\%(hex\)\?"/ skip=/\\./ end=/"/
syntax region yulString start=/\%(hex\)\?'/ skip=/\\./ end=/'/
syntax keyword yulTodo TODO FIXME XXX NOTE contained
syntax region yulComment start=+//+ end=+$+ contains=yulTodo,@Spell
syntax region yulComment start=+/\*+ end=+\*/+ contains=yulTodo,@Spell

highlight default link yulKeyword Keyword
highlight default link yulConditional Conditional
highlight default link yulRepeat Repeat
highlight default link yulBoolean Boolean
highlight default link yulOperator Operator
highlight default link yulNumber Number
highlight default link yulBuiltin Function
highlight default link yulFunction Function
highlight default link yulString String
highlight default link yulComment Comment
highlight default link yulTodo Todo

let b:current_syntax = 'yul'
