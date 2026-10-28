"""Build the self-contained CrisperWhisper inference sidecar for macOS arm64."""

from pathlib import Path
import os
import platform
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
SIDE = Path(__file__).resolve().parent
OUT = Path(os.environ.get("CRISPERWHISPER_DIST_DIR", ROOT / "src-tauri" / "binaries"))
NAME = "crisperwhisper-cli-aarch64-apple-darwin"


def main() -> None:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("CrisperWhisper release sidecar requires macOS arm64")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--onefile",
            "--noconfirm",
            "--name",
            NAME,
            "--distpath",
            str(OUT),
            "--workpath",
            str(SIDE / "build"),
            "--specpath",
            str(SIDE / "build"),
            "--collect-all",
            "crisperwhisper",
            "--copy-metadata",
            "crisperwhisper",
            "--copy-metadata",
            "transformers",
            str(ROOT / "src-tauri" / "src" / "crisperwhisper_bridge.py"),
        ],
        check=True,
        cwd=ROOT,
        env={**os.environ, "PYINSTALLER_CONFIG_DIR": str(SIDE / "build" / "config")},
    )


if __name__ == "__main__":
    main()
