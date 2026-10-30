"""Disposable process-tree/HTTP fixture; never imports the Aelys backend."""

import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

mode = sys.argv[1]
state = Path(os.environ["AELYS_TEST_STATE"])
port = int(sys.argv[sys.argv.index("--port") + 1])
(state / f"{mode}.pid").write_text(str(os.getpid()))

if mode == "backend":
    if os.environ.get("AELYS_TEST_BACKEND_EXIT"):
        sys.exit(7)
    while (
        os.environ.get("AELYS_TEST_BACKEND_WAIT")
        and not (state / "allow-backend").exists()
    ):
        time.sleep(0.02)

if mode == "web":
    if exit_code := os.environ.get("AELYS_TEST_WEB_EXIT"):
        sys.exit(int(exit_code))
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); (Path(os.environ['AELYS_TEST_STATE']) / 'descendant.ready').touch(); time.sleep(60)",
        ]
    )
    (state / "descendant.pid").write_text(str(child.pid))
    while not (state / "descendant.ready").exists():
        time.sleep(0.01)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = None
        if self.path == "/healthz":
            payload = {"status": "ok"}
        elif self.path == "/api/v1/openapi.json" and mode == "backend":
            payload = {
                "info": {"title": "Aelys API"},
                "paths": {"/api/v1/me": {}, "/api/v1/tasks": {}},
            }
        elif self.path == "/__aelys_dev" and mode == "web":
            payload = {
                "service": "aelys-web",
                "backend_origin": os.environ.get("AELYS_BACKEND_ORIGIN"),
            }
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(200 if payload else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def watch_exit():
    while not (state / f"stop-{mode}").exists():
        time.sleep(0.02)
    os._exit(7)


threading.Thread(target=watch_exit, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
