#!/usr/bin/env python3
"""
One-command launcher for Google Colab Pro:
1. Starts FastAPI (server.py) on port 8000.
2. Downloads cloudflared if missing and opens a free public HTTPS tunnel.
3. Prints the public https://*.trycloudflare.com URL as soon as it is ready.
"""

import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))
CLOUDFLARED_PATH = Path("/usr/local/bin/cloudflared")
CLOUDFLARED_URL = (
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
)


def ensure_cloudflared() -> str:
    found = shutil.which("cloudflared")
    if found:
        return found
    target = CLOUDFLARED_PATH if os.access(CLOUDFLARED_PATH.parent, os.W_OK) else BASE_DIR / "cloudflared"
    if not target.exists():
        print("[1/3] Đang tải cloudflared...")
        urllib.request.urlretrieve(CLOUDFLARED_URL, target)
        target.chmod(0o755)
    return str(target)


def main() -> None:
    cf_bin = ensure_cloudflared()

    print(f"[2/3] Khởi động FastAPI server trên cổng {PORT}...")
    server_proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(BASE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    time.sleep(2.0)
    if server_proc.poll() is not None:
        out = server_proc.stdout.read() if server_proc.stdout else ""
        print("[LỖI] FastAPI không khởi động được:\n", out)
        sys.exit(1)

    print("[3/3] Đang mở Cloudflare Tunnel (chờ vài giây để nhận link HTTPS)...")
    cf_proc = subprocess.Popen(
        [cf_bin, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    url_re = re.compile(r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)")
    public_url = None
    try:
        assert cf_proc.stdout is not None
        for line in cf_proc.stdout:
            m = url_re.search(line)
            if m and not public_url:
                public_url = m.group(1)
                print("\n" + "=" * 68)
                print(f"  WEB UI ĐÃ SẴN SÀNG:  {public_url}")
                print("  Giữ cell này đang chạy trong suốt lúc demo. Bấm Stop để tắt.")
                print("=" * 68 + "\n", flush=True)
    except KeyboardInterrupt:
        print("\nĐang dừng server và tunnel...")
    finally:
        cf_proc.terminate()
        server_proc.terminate()


if __name__ == "__main__":
    main()
