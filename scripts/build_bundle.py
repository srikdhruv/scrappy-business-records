"""Build the self-contained bundle: dist/scrappy-records-<platform>.zip.

    make package                                   # = make build, then this script
    uv run --project backend python scripts/build_bundle.py [--platform windows-x64|macos-arm64]

The zip holds everything the app needs on a laptop with nothing installed:

    python/                  pinned python-build-standalone CPython 3.12 ("install_only")
      .../site-packages/     runtime dependencies from uv.lock, plus scrappy-records.pth
    app/                     the backend package, migrations and the built UI in app/static/
    VERSION                  from backend/pyproject.toml
    scrappy.ico, scrappy.png the app icon (shortcut icon on Windows, .app icon on macOS)
    Start Scrappy Records.cmd       (Windows) debug launcher that shows errors in a console
    Start Scrappy Records.command   (macOS)   the same

`scrappy-records.pth` adds the bundle folder to `sys.path`, so `python -m app.launcher` works
whatever the current folder is. Downloads are cached in ~/.cache/scrappy-bundle and checked
against the SHA-256 sums pinned below.

After building for the machine it runs on, the script unpacks the zip into a temporary folder
and self-tests it with a clean environment (no dev virtualenv, no PATH to other Pythons): it
starts the server from the bundle and checks /api/health and the UI. `--platform` for another
OS builds the zip but skips the self-test.
"""

from __future__ import annotations

import argparse
import compileall
import hashlib
import json
import os
import platform
import py_compile
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
APP_SRC = BACKEND / "app"
DIST = ROOT / "dist"
WORK = ROOT / "bundle"
CACHE = Path.home() / ".cache" / "scrappy-bundle"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_icon import write_icons  # noqa: E402

# --- pinned interpreter ------------------------------------------------------------------------
# To update: pick a release at https://github.com/astral-sh/python-build-standalone/releases,
# copy the sha256 of each "cpython-3.12.*-<triple>-install_only.tar.gz" asset (the release's
# SHA256SUMS file, or `gh api repos/astral-sh/python-build-standalone/releases/tags/<tag>`).
PBS_RELEASE = "20260924"
PYTHON_VERSION = "3.12.14"


@dataclass(frozen=True)
class Target:
    triple: str
    sha256: str
    python: str  # interpreter, relative to the bundle root
    site_packages: str
    pth_to_root: str  # the bundle root, relative to site-packages (.pth lines are relative)


TARGETS = {
    "windows-x64": Target(
        triple="x86_64-pc-windows-msvc",
        sha256="c5303174bc29f5205decf6721ac549d4eb41c448f9b8c46cbc562d00348865bb",
        python="python/python.exe",
        site_packages="python/Lib/site-packages",
        pth_to_root="../../..",
    ),
    "macos-arm64": Target(
        triple="aarch64-apple-darwin",
        sha256="9763f43db2481a6af36af82ec40302aab7a73632f880129d07a6e81aec846277",
        python="python/bin/python3",
        site_packages="python/lib/python3.12/site-packages",
        pth_to_root="../../../..",
    ),
}

# Parts of the standard library the app never uses; dropping them makes the download smaller.
PRUNE = ("test", "idlelib", "turtledemo", "tkinter", "lib2to3", "ensurepip")

WINDOWS_CMD = r"""@echo off
rem Starts Scrappy Records like the Desktop shortcut does, but in a console so errors show.
cd /d "%~dp0"
"%~dp0python\python.exe" -m app.launcher
if errorlevel 1 (
  echo.
  echo Scrappy Records did not start. The log is in %LOCALAPPDATA%\ScrappyRecords\logs\server.log
  pause
)
"""

MAC_COMMAND = """#!/bin/sh
# Starts Scrappy Records like the app icon does, but in Terminal so errors show.
cd "$(dirname "$0")" || exit 1
./python/bin/python3 -m app.launcher || {
  echo
  echo "Scrappy Records did not start. The log is in:"
  echo "  $HOME/Library/Application Support/ScrappyRecords/logs/server.log"
  read -r _
}
"""


def step(msg: str) -> None:
    print(f"==> {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"\nbuild_bundle: ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def host_platform() -> str | None:
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in ("amd64", "x86_64"):
        return "windows-x64"
    if sys.platform == "darwin" and machine == "arm64":
        return "macos-arm64"
    return None


def project_version() -> str:
    data = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch_python(target: Target) -> Path:
    name = f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-{target.triple}-install_only.tar.gz"
    url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_RELEASE}/{name}"
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.is_file() and sha256(path) == target.sha256:
        step(f"Using cached {name}")
        return path
    step(f"Downloading {url}")
    partial = path.with_name(name + ".partial")
    with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as out:
        shutil.copyfileobj(response, out)
    actual = sha256(partial)
    if actual != target.sha256:
        partial.unlink()
        fail(f"Checksum mismatch for {name}:\n  expected {target.sha256}\n  got      {actual}")
    os.replace(partial, path)
    return path


def stdlib_dir(bundle: Path, target: Target) -> Path:
    return (bundle / target.site_packages).parent


def install_python(archive: Path, bundle: Path, target: Target) -> None:
    step("Unpacking the Python interpreter")
    with tarfile.open(archive) as tar:
        tar.extractall(bundle, filter="data")  # creates bundle/python/
    # Our private interpreter: allow installing packages into it.
    for marker in (bundle / "python").rglob("EXTERNALLY-MANAGED"):
        marker.unlink()
    lib = stdlib_dir(bundle, target)
    for name in PRUNE:
        shutil.rmtree(lib / name, ignore_errors=True)
    shutil.rmtree(bundle / "python" / "tcl", ignore_errors=True)  # Tk data (Windows)


def uv_exe() -> str:
    uv = os.environ.get("UV") or shutil.which("uv")
    if not uv:
        fail("uv is needed to build the bundle: https://docs.astral.sh/uv/")
    return uv


def install_dependencies(bundle: Path, target: Target, native: bool) -> None:
    step("Installing runtime dependencies from uv.lock")
    uv = uv_exe()
    with tempfile.TemporaryDirectory() as tmp:
        reqs = Path(tmp) / "requirements.txt"
        subprocess.run(
            [
                uv,
                "export",
                "--project",
                str(BACKEND),
                "--frozen",
                "--no-dev",
                "--no-emit-project",
                "--format",
                "requirements-txt",
                "--output-file",
                str(reqs),
                "--quiet",
            ],
            check=True,
        )
        cmd = [uv, "pip", "install", "--no-config", "--link-mode", "copy"]
        cmd += ["--only-binary", ":all:", "--require-hashes", "-r", str(reqs)]
        if native:
            cmd += ["--python", str(bundle / target.python)]
        else:
            # Cross-build: pick the other platform's wheels and install them straight in.
            cmd += ["--target", str(bundle / target.site_packages)]
            cmd += ["--python-platform", target.triple, "--python-version", "3.12"]
        # Run outside the repo so no project settings or virtualenv get picked up.
        env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "PYTHONPATH")}
        subprocess.run(cmd, check=True, cwd=tmp, env=env)


def copy_app(bundle: Path) -> None:
    step("Copying the app (backend package, migrations, built UI)")
    if not (APP_SRC / "static" / "index.html").is_file():
        fail("The UI isn't built (backend/app/static/index.html is missing). Run `make build`.")
    shutil.copytree(
        APP_SRC,
        bundle / "app",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "tests", ".DS_Store"),
    )


def add_extras(bundle: Path, target: Target, name: str, version: str) -> None:
    step("Adding VERSION, icon, .pth file and the debug launcher")
    (bundle / "VERSION").write_text(version + "\n", encoding="utf-8")
    write_icons(bundle)
    pth = bundle / target.site_packages / "scrappy-records.pth"
    pth.write_text(target.pth_to_root + "\n", encoding="utf-8")
    if name.startswith("windows"):
        (bundle / "Start Scrappy Records.cmd").write_bytes(WINDOWS_CMD.replace("\n", "\r\n").encode())
    else:
        command = bundle / "Start Scrappy Records.command"
        command.write_text(MAC_COMMAND, encoding="utf-8")
        command.chmod(0o755)


def precompile(bundle: Path, target: Target, native: bool) -> None:
    """Compile .pyc files up front, so the first start on a slow laptop is quicker.

    "unchecked-hash" .pyc files stay valid whatever timestamps the unzip gives the sources; the
    whole folder is replaced on every update, so they can't go stale.
    """
    step("Pre-compiling Python files")
    dirs = [bundle / target.site_packages, bundle / "app"]
    if native:
        subprocess.run(
            [str(bundle / target.python), "-m", "compileall", "-q", "-j", "0"]
            + ["--invalidation-mode", "unchecked-hash", *map(str, dirs)],
            check=True,
            env=clean_env(),
        )
    elif sys.version_info[:2] == (3, 12):
        for d in dirs:
            compileall.compile_dir(
                d,
                quiet=1,
                workers=0,
                invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
            )


def write_zip(bundle: Path, out: Path) -> None:
    step(f"Writing {out.relative_to(ROOT)}")
    out.parent.mkdir(parents=True, exist_ok=True)
    partial = out.with_name(out.name + ".partial")
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in sorted(bundle.rglob("*")):
            arcname = path.relative_to(bundle).as_posix()
            st = path.lstat()
            if stat.S_ISLNK(st.st_mode):
                # Keep symlinks as symlinks (macOS Python has a few); unzip restores them.
                info = zipfile.ZipInfo(arcname, time.localtime(st.st_mtime)[:6])
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                zf.writestr(info, os.readlink(path))
            elif path.is_dir():
                continue
            else:
                zf.write(path, arcname)
    os.replace(partial, out)


# --------------------------------------------------------------------------- self-test


def clean_env(**extra: str) -> dict[str, str]:
    """An environment with no developer tools: no virtualenv, no uv, no other Python."""
    keep = (
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "HOME",
        "USER",
        "LANG",
    )
    env = {k: os.environ[k] for k in keep if k in os.environ}
    if sys.platform == "win32":
        root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        env["PATH"] = os.pathsep.join([rf"{root}\System32", root])
    else:
        env["PATH"] = "/usr/bin:/bin"
    env.update(extra)
    return env


def unzip(zip_path: Path, dest: Path) -> None:
    if sys.platform == "win32":
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(dest)
    else:
        # The system unzip restores permissions and symlinks, like the installer's does.
        subprocess.run(["/usr/bin/unzip", "-q", str(zip_path), "-d", str(dest)], check=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url: str, timeout: float = 2.0) -> tuple[int, bytes]:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as r:
        return r.status, r.read()


def self_test(zip_path: Path, target: Target, version: str) -> None:
    step("Self-test: unpacking the zip and starting the server from it, with no dev tools")
    with tempfile.TemporaryDirectory(prefix="scrappy-selftest-") as tmp:
        tmp_path = Path(tmp)
        bundle, home, elsewhere = tmp_path / "app", tmp_path / "home", tmp_path / "elsewhere"
        elsewhere.mkdir()
        unzip(zip_path, bundle)
        python = bundle / target.python
        port = free_port()
        env = clean_env(
            SCRAPPY_HOME=str(home),
            SCRAPPY_BACKUP_DIR=str(home / "backups"),
            SCRAPPY_PORT=str(port),
        )

        def run(*args: str) -> str:
            result = subprocess.run(
                [str(python), *args], cwd=elsewhere, env=env, capture_output=True, text=True
            )
            if result.returncode != 0:
                fail(f"`python {' '.join(args)}` failed:\n{result.stdout}{result.stderr}")
            return result.stdout.strip()

        # `import app` must find the bundle's copy from any folder (the .pth file).
        where = Path(run("-c", "import app; print(app.__file__)"))
        if not where.resolve().is_relative_to(bundle.resolve()):
            fail(f"`import app` found {where}, not the bundle's copy")
        run("-c", "import fastapi, uvicorn, sqlalchemy, alembic, platformdirs, pydantic, sqlite3")
        run("-m", "app.backup", "--reason", "manual")  # no database yet: must succeed

        server = subprocess.Popen(
            [str(python), "-m", "app.server"],
            cwd=elsewhere,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            health = None
            while time.monotonic() < deadline and server.poll() is None:
                try:
                    health = json.loads(get(f"http://127.0.0.1:{port}/api/health")[1])
                    break
                except OSError:
                    time.sleep(0.5)
            if health is None:
                server.kill()
                output = server.communicate()[0].decode(errors="replace")
                log = home / "logs" / "server.log"
                log_text = log.read_text(errors="replace") if log.is_file() else "(no log)"
                fail(f"The bundled server didn't answer.\n{output}\n--- server.log ---\n{log_text}")
            expected = {"app": "scrappy-records", "version": version, "status": "ok"}
            if health != expected:
                fail(f"/api/health returned {health}, expected {expected}")
            status, page = get(f"http://127.0.0.1:{port}/")
            if status != 200 or b"<title>Scrappy Records</title>" not in page:
                fail("The UI wasn't served at /")
            for must_exist in (home / "data" / "records.db", home / "logs" / "server.log"):
                if not must_exist.is_file():
                    fail(f"{must_exist} wasn't created")
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
            if server.stdout:
                server.stdout.close()
    step(f"Self-test passed: /api/health answered {health}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--platform", choices=sorted(TARGETS), default=host_platform())
    parser.add_argument("--skip-self-test", action="store_true")
    args = parser.parse_args()
    if args.platform is None:
        fail("Can't tell which bundle to build on this machine; pass --platform.")
    name, target = args.platform, TARGETS[args.platform]
    native = name == host_platform()
    version = project_version()
    step(f"Building scrappy-records {version} for {name}")

    copy_needed = not (APP_SRC / "static" / "index.html").is_file()
    if copy_needed:
        fail("The UI isn't built (backend/app/static/index.html is missing). Run `make build`.")

    bundle = WORK / name
    shutil.rmtree(bundle, ignore_errors=True)
    bundle.mkdir(parents=True)
    install_python(fetch_python(target), bundle, target)
    install_dependencies(bundle, target, native)
    copy_app(bundle)
    add_extras(bundle, target, name, version)
    precompile(bundle, target, native)
    out = DIST / f"scrappy-records-{name}.zip"
    write_zip(bundle, out)
    size_mb = out.stat().st_size / 1e6
    step(f"Built {out.relative_to(ROOT)} ({size_mb:.1f} MB)")

    if not native:
        print(f"(Skipping the self-test: this machine can't run a {name} bundle.)")
    elif args.skip_self_test:
        print("(Skipping the self-test, as asked.)")
    else:
        self_test(out, target, version)


if __name__ == "__main__":
    main()
