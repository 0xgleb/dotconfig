# Upstream provenance

Vendored from [`burneikis/pi-vim`](https://github.com/burneikis/pi-vim) at commit
[`8b99eccdcc4c6e472a52f2f334cac0284a597258`](https://github.com/burneikis/pi-vim/commit/8b99eccdcc4c6e472a52f2f334cac0284a597258).

The implementation is MIT licensed; see `LICENSE`.

Local compatibility adaptations are intentionally mechanical:

- `@mariozechner/pi-coding-agent` -> `@earendil-works/pi-coding-agent`
- `@mariozechner/pi-tui` -> `@earendil-works/pi-tui`
- relative `.js` imports -> `.ts` imports for direct execution from this source tree

No Vim behavior is maintained locally beyond those compatibility changes.
