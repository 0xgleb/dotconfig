"""Check Rust watcher opt-out and actual Neovim quit latency with a live LSP."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

config = Path(__file__).resolve().parent
root = Path(tempfile.mkdtemp(prefix="nvim-rust-quit-"))
(root / "src").mkdir()
(root / "Cargo.toml").write_text(
    '[package]\nname = "quit_regression"\nversion = "0.1.0"\nedition = "2021"\n'
)
(root / "src/main.rs").write_text("fn main() {}\n")
setup = (
    f"lua vim.g.quit_fixture_root={json.dumps(str(root))}; "
    f"dofile({json.dumps(str(config / 'test_rust_exit.lua'))})"
)
try:
    result = subprocess.run(
        ["nvim", "--headless", "-i", "NONE", "-c", setup],
        capture_output=True, text=True, timeout=35,
    )
    ended = time.time()
    output = result.stderr + result.stdout
    marker = re.search(r"QUIT_START (\d+\.\d+)", output)
    assert result.returncode == 0 and marker, output
    elapsed = ended - float(marker.group(1))
    assert elapsed < 0.5, f"Quit blocked for {elapsed:.3f}s\n{output}"
    print(f"PASS: Rust watches files in the server process; quit took {elapsed:.3f}s")
finally:
    shutil.rmtree(root)
