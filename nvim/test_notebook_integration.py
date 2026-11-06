"""Owned Neovim + actual IHaskell, synthetic notebooks only.

Run inside the project's research shell: python ~/.config/nvim/test_notebook_integration.py RESEARCH_DIR
"""

import json
import os
import fcntl
import pty
import struct
import termios
import threading
from pathlib import Path
import shutil
import subprocess
import sys
import faulthandler
from tempfile import TemporaryDirectory
from time import monotonic, sleep

import nbformat
import pynvim

faulthandler.dump_traceback_later(60, repeat=True)


def lua(editor, code, *args):
    return editor.exec_lua(code, *args)


def run(editor, root, text, occurrence=0):
    lines = list(editor.current.buffer)
    rows = [index + 1 for index, line in enumerate(lines) if line == text]
    editor.current.window.cursor = (rows[occurrence], 0)
    editor.command("NotebookRun")
    assert editor.current.buffer.options[
        "modified"
    ], "new execution outputs must need saving"
    deadline = monotonic() + 120
    while monotonic() < deadline:
        editor.command(
            f"MoltenSave {root / 'outputs.json'} {editor.funcs.MoltenRunningKernels(True)[0]}"
        )
        cells = json.loads((root / "outputs.json").read_text())["cells"]
        if cells and all(cell["status"] not in (0, 1) for cell in cells):
            return
        sleep(0.05)
    raise AssertionError("IHaskell did not finish")


def patch(editor, path, old, new):
    before = lua(
        editor,
        "return require('research.notebook').request(...)",
        {"op": "read", "path": str(path)},
    )
    result = lua(
        editor,
        "return require('research.notebook').request(...)",
        {
            "op": "patch",
            "path": str(path),
            "changedtick": before["changedtick"],
            "old": old,
            "new": new,
        },
    )
    assert result["ok"], result
    return result


with TemporaryDirectory(prefix="research-editor-") as directory:
    root = Path(directory)
    project = Path(sys.argv[1]).resolve()
    shutil.copy(project / ".envrc", root)
    shutil.copytree(project / "src", root / "src")
    shutil.copytree(project / "data", root / "data")
    path = root / "workflow.ipynb"
    shutil.copy(project / "workflow.ipynb", path)
    argv = [
        os.environ.get("RESEARCH_NVIM", "nvim"),
        "--headless",
        "-i",
        "NONE",
        "--listen",
        str(root / "editor.sock"),
    ]
    if "RESEARCH_NVIM_INIT" in os.environ:
        argv.extend(["-u", os.environ["RESEARCH_NVIM_INIT"]])
    # image.nvim's Kitty backend requires a real tty even for headless API tests.
    # This is an owned pseudoterminal; it does not claim visual Ghostty coverage.
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 960, 640))
    process = subprocess.Popen(
        argv, cwd=root, stdin=slave, stdout=slave, stderr=slave, start_new_session=True
    )
    os.close(slave)

    def drain_terminal():
        try:
            while os.read(master, 65536):
                pass
        except OSError:
            pass

    threading.Thread(target=drain_terminal, daemon=True).start()
    deadline = monotonic() + 30
    while not (root / "editor.sock").exists():
        assert (
            process.poll() is None and monotonic() < deadline
        ), "Test editor did not start"
        sleep(0.05)
    editor = pynvim.attach("socket", path=str(root / "editor.sock"))
    try:
        editor.chdir(str(root))
        lua(
            editor,
            "vim.g.research_test_notifications = {}; vim.notify = function(message) local log = vim.g.research_test_notifications; table.insert(log, message); vim.g.research_test_notifications = log end",
        )
        editor.command(f"edit {path}")
        print("Opened notebook", editor.current.buffer.options["filetype"], flush=True)
        editor.command("NotebookShare")
        print("Shared notebook", flush=True)
        # Test the real CLI transport, including quotes/newlines in JSON payloads.
        read = subprocess.run(
            [
                "nu",
                str(project / "editor.nu"),
                "read",
                str(path),
                "--socket",
                str(root / ".direnv/research.sock"),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        live = json.loads(read.stdout)
        assert live["source"].startswith("---")
        (root / "old.txt").write_text("# Synthetic workflow")
        (root / "new.txt").write_text("# Synthetic workflow\n\nAgent's note")
        applied = subprocess.run(
            [
                "nu",
                str(project / "editor.nu"),
                "patch",
                str(path),
                "--revision",
                str(live["changedtick"]),
                "--old",
                str(root / "old.txt"),
                "--new",
                str(root / "new.txt"),
                "--socket",
                str(root / ".direnv/research.sock"),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "Agent's note" in json.loads(applied.stdout)["source"]
        assert editor.current.buffer.options["filetype"] == "markdown", (editor.current.buffer.name, editor.current.buffer.options["filetype"], list(editor.current.buffer)[:3])
        try:
            editor.command("NotebookInit")
        except pynvim.api.common.NvimError:
            print(lua(editor, "return vim.g.research_test_notifications"), flush=True)
            raise
        print("Initialized IHaskell", flush=True)
        deadline = monotonic() + 90
        while not editor.current.buffer.vars.get("research_kernel_ready", False):
            assert monotonic() < deadline, "IHaskell did not become ready"
            sleep(0.05)
        kernel = editor.funcs.MoltenRunningKernels(True)
        run(editor, root, ":set -isrc")
        run(editor, root, ":load src/Research/Workspace.hs")
        run(editor, root, 'dataset <- loadExample "data/example.json"')
        run(editor, root, "summarize dataset")
        run(editor, root, "plotExample dataset")
        editor.command("write")
        notebook = nbformat.read(path, as_version=4)
        assert "(3,6)" in json.dumps(notebook.cells[4].outputs).replace(" ", ""), [
            cell.get("outputs") for cell in notebook.cells
        ]
        assert any(
            mime.startswith("image/")
            for output in notebook.cells[5].outputs
            for mime in output.get("data", {})
        )
        image_output = notebook.cells[5].outputs
        assert editor.funcs.MoltenRunningKernels(True) == kernel

        # Partial edits preserve human work and never execute or save it.
        editor.current.buffer.append("Human unsaved note")
        old_disk = path.read_bytes()
        result = patch(
            editor, path, "# Synthetic workflow", "# Synthetic workflow: agent's edit"
        )
        assert "Human unsaved note" in result["source"] and result["modified"]
        assert (
            path.read_bytes() == old_disk
            and editor.funcs.MoltenRunningKernels(True) == kernel
        )
        # Stale outputs must be discarded even if someone saves immediately.
        editor.command("write")
        notebook = nbformat.read(path, as_version=4)
        assert all(
            not cell.outputs for cell in notebook.cells if cell.cell_type == "code"
        )
        # Kernel variables survive notebook edits, without executing load again.
        (root / "data/example.json").unlink()
        run(editor, root, "summarize dataset")
        editor.command("write")
        assert nbformat.read(path, as_version=4).cells[4].outputs

        # A live .hs patch appears immediately; save it, reload, rebind from cache.
        editor.command(f"split {root / 'src/Research/Workspace.hs'}")
        module = root / "src/Research/Workspace.hs"
        patched = patch(editor, module, "sum values)", "sum values + 10)")
        assert patched["modified"] and "sum values + 10)" in "\n".join(
            editor.current.buffer
        )
        editor.command("write")
        editor.command("close")
        run(editor, root, ":reload")
        run(editor, root, 'dataset <- loadExample "data/example.json"')
        run(editor, root, "summarize dataset")
        editor.command("write")
        notebook = nbformat.read(path, as_version=4)
        assert "(3,16)" in json.dumps(notebook.cells[4].outputs).replace(
            " ", ""
        ), notebook.cells[4].outputs
        assert editor.funcs.MoltenRunningKernels(True) == kernel
        editor.command("MoltenDeinit")
        persisted = nbformat.read(path, as_version=4)
        editor.command("write")
        assert (
            nbformat.read(path, as_version=4).cells[4].outputs
            == persisted.cells[4].outputs
        )

        # Identical sources: running only the second cell must not fill the first.
        duplicate = root / "duplicates.ipynb"
        book = nbformat.v4.new_notebook(
            cells=[
                nbformat.v4.new_code_cell("40 + 2"),
                nbformat.v4.new_code_cell("40 + 2"),
            ],
            metadata=dict(notebook.metadata),
        )
        nbformat.write(book, duplicate)
        editor.command(f"edit {duplicate}")
        editor.command("NotebookInit")
        deadline = monotonic() + 90
        while not editor.current.buffer.vars.get("research_kernel_ready", False):
            assert monotonic() < deadline, "IHaskell did not become ready"
            sleep(0.05)
        run(editor, root, "40 + 2", occurrence=1)
        editor.command("write")
        saved = nbformat.read(duplicate, as_version=4)
        assert not saved.cells[0].outputs and saved.cells[1].outputs, saved.cells
        editor.command("MoltenDeinit")

        # Import must anchor to code fences, preserve old MIME/error data, and
        # save new stream output even when execution_count repeats after restart.
        historical = root / "historical.ipynb"
        stream_source = 'readFile "stream.txt" >>= putStrLn'
        stream = nbformat.v4.new_code_cell(
            stream_source,
            execution_count=1,
            outputs=[nbformat.v4.new_output("stream", name="stdout", text="old\n")],
        )
        error = nbformat.v4.new_code_cell(
            "missingSymbol",
            execution_count=2,
            outputs=[
                nbformat.v4.new_output(
                    "error",
                    ename="Synthetic",
                    evalue="old error",
                    traceback=["synthetic traceback"],
                )
            ],
        )
        image = nbformat.v4.new_code_cell(
            "historicalChart", execution_count=3, outputs=image_output
        )
        saved_book = nbformat.v4.new_notebook(
            cells=[nbformat.v4.new_markdown_cell(stream_source), stream, error, image],
            metadata=dict(notebook.metadata),
        )
        saved_book.metadata["preserve_me"] = {"number": 42}
        nbformat.write(saved_book, historical)
        editor.command(f"edit {historical}")
        editor.command("NotebookInit")
        deadline = monotonic() + 90
        while not editor.current.buffer.vars.get("research_kernel_ready", False):
            assert monotonic() < deadline, "IHaskell did not become ready"
            sleep(0.05)
        editor.command("write")
        roundtrip = nbformat.read(historical, as_version=4)
        assert [cell.get("outputs") for cell in roundtrip.cells] == [
            cell.get("outputs") for cell in saved_book.cells
        ]
        assert roundtrip.metadata["preserve_me"] == {"number": 42}
        # Molten's ready event supplies kernel_id without an owning buffer.
        owner = editor.current.buffer.number
        owner_kernel = editor.funcs.MoltenRunningKernels(True)[0]
        editor.command(f"split {module}")
        lua(
            editor,
            "local owner, kernel = ...; vim.b[owner].research_kernel_ready=false; vim.api.nvim_exec_autocmds('User', {pattern='MoltenKernelReady', data={kernel_id=kernel}})",
            owner,
            owner_kernel,
        )
        assert lua(editor, "return vim.b[...].research_kernel_ready", owner)
        assert not editor.current.buffer.vars.get("research_kernel_ready", False)
        editor.command("close")
        (root / "stream.txt").write_text("new")
        run(editor, root, stream_source, occurrence=1)
        editor.command("write")
        roundtrip = nbformat.read(historical, as_version=4)
        assert roundtrip.cells[1].execution_count == 1
        assert "new" in "".join(
            output.get("text", "") + output.get("data", {}).get("text/plain", "")
            for output in roundtrip.cells[1].outputs
        )
        assert (
            roundtrip.cells[2].outputs == error.outputs
            and roundtrip.cells[3].outputs == image.outputs
        )
        editor.command("MoltenDeinit")

        # Conversion and disk conflicts fail without replacing the canonical file.
        editor.command(f"edit {duplicate}")
        editor.current.buffer.append("Unsaved change")
        original = duplicate.read_bytes()
        editor.command("let $PATH = '/nonexistent'")
        try:
            editor.command("write")
            raise AssertionError("missing converter was accepted")
        except pynvim.api.common.NvimError:
            pass
        assert (
            editor.current.buffer.options["modified"]
            and duplicate.read_bytes() == original
        )
        duplicate.write_text(original.decode() + "\n")
        try:
            editor.command("write")
            raise AssertionError("external disk conflict was accepted")
        except pynvim.api.common.NvimError:
            pass
        assert duplicate.read_text() == original.decode() + "\n"
        print(
            "Neovim/IHaskell: outputs, duplicate cells, live edits, preserved human work, reload without IO, and save failures passed"
        )
    finally:
        try:
            if editor.funcs.MoltenRunningKernels(True):
                editor.command("MoltenDeinit")
            editor.command("qa!")
        except (EOFError, OSError):
            pass
        editor.close()
        process.wait(timeout=10)
        os.close(master)
