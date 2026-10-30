"""Start local Aelys services; supervise only processes created by this run."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from http.client import HTTPException
from pathlib import Path
from types import FrameType
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def read_json(url: str, limit: int = 2 * 1024 * 1024) -> dict[str, object] | None:
    try:
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(
            Request(url, headers={"Accept": "application/json"}), timeout=1
        ) as response:
            body = bytearray()
            deadline = time.monotonic() + 1
            while len(body) <= limit:
                if time.monotonic() >= deadline:
                    return None
                chunk = response.read1(min(65536, limit + 1 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
        if len(body) > limit:
            return None
        value = json.loads(body)
        return value if isinstance(value, dict) else None
    except (OSError, URLError, ValueError, HTTPException):
        return None


def backend_is_aelys(origin: str) -> bool:
    health = read_json(f"{origin}/healthz", 4096)
    if not health or health.get("status") != "ok":
        return False
    schema = read_json(f"{origin}/api/v1/openapi.json") or {}
    info, paths = schema.get("info"), schema.get("paths")
    return (
        isinstance(info, dict)
        and info.get("title") == "Aelys API"
        and isinstance(paths, dict)
        and "/api/v1/me" in paths
        and "/api/v1/tasks" in paths
    )


def web_is_aelys(port: int, backend: str) -> bool:
    identity = read_json(f"http://127.0.0.1:{port}/__aelys_dev", 8192)
    return bool(
        identity
        and identity.get("service") == "aelys-web"
        and identity.get("backend_origin") == backend
    )


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def configured_port(env: dict[str, str], name: str, default: int) -> int:
    try:
        port = int(env.get(name, str(default)))
        if not 1 <= port <= 65535:
            raise ValueError
        return port
    except ValueError:
        raise ValueError(f"{name} must be an integer between 1 and 65535") from None


def backend_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (
            any(character.isspace() for character in value)
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError
        _ = parsed.port
    except ValueError:
        raise ValueError(
            "AELYS_BACKEND_ORIGIN must be an HTTP(S) origin without credentials, path or query"
        ) from None
    return value.rstrip("/")


class LocalLauncher:
    def __init__(self, root: Path, env: dict[str, str]):
        self.root = root
        self.env = env
        self.children: list[subprocess.Popen[bytes]] = []
        self.stop_signal = 0

    def spawn(
        self, command: list[str], cwd: Path, env: dict[str, str]
    ) -> subprocess.Popen[bytes]:
        # Separate sessions reach pnpm/Vite descendants without signalling the
        # caller's shell or any reused process.
        child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
        self.children.append(child)
        return child

    def cleanup(self) -> None:
        for child in reversed(self.children):
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        for child in self.children:
            try:
                child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        # Leaders can exit while descendants ignore TERM. Close those owned
        # groups too instead of assuming leader termination proves cleanup.
        for child in self.children:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()

    def select_backend(self) -> tuple[str, int, bool]:
        port = configured_port(self.env, "AELYS_BACKEND_PORT", 8000)
        explicit = self.env.get("AELYS_BACKEND_ORIGIN")
        if explicit:
            origin = backend_origin(explicit)
            if not backend_is_aelys(origin):
                raise RuntimeError(
                    "The configured backend is unavailable or is not Aelys"
                )
            return origin, port, False
        candidates = (
            [port]
            if "AELYS_BACKEND_PORT" in self.env
            else list(dict.fromkeys([port, *range(8001, 8011)]))
        )
        for candidate in candidates:
            if self.stop_signal:
                raise InterruptedError
            origin = f"http://127.0.0.1:{candidate}"
            if backend_is_aelys(origin):
                return origin, candidate, False
            if port_is_free(candidate):
                return origin, candidate, True
        raise RuntimeError("No available backend port; choose AELYS_BACKEND_PORT")

    def select_web(self, origin: str) -> tuple[int, bool]:
        port = configured_port(self.env, "AELYS_WEB_PORT", 5173)
        candidates = (
            [port]
            if "AELYS_WEB_PORT" in self.env
            else list(dict.fromkeys([port, *range(5174, 5181)]))
        )
        for candidate in candidates:
            if self.stop_signal:
                raise InterruptedError
            if web_is_aelys(candidate, origin):
                return candidate, False
            if port_is_free(candidate):
                return candidate, True
        raise RuntimeError("No available web port; choose AELYS_WEB_PORT")

    def launch(self) -> int:
        origin, port, start_backend = self.select_backend()
        web_port, start_web = self.select_web(origin)
        if start_backend and web_port == port:
            raise ValueError("Backend and web ports must be different")
        uvicorn = self.root / ".venv/bin/uvicorn"
        pnpm = shutil.which("pnpm", path=self.env.get("PATH"))
        if start_backend and not uvicorn.is_file():
            raise RuntimeError(
                "Backend environment missing; install .venv dependencies first"
            )
        if start_web and not pnpm:
            raise RuntimeError("pnpm is missing from PATH")
        if self.stop_signal:
            return 128 + self.stop_signal
        backend = None
        if start_backend:
            print(f"Starting Aelys backend: {origin}", flush=True)
            backend = self.spawn(
                [
                    str(uvicorn),
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ],
                self.root / "backend",
                self.env,
            )
            deadline = time.monotonic() + 30
            while not backend_is_aelys(origin):
                if self.stop_signal:
                    return 128 + self.stop_signal
                if backend.poll() is not None:
                    raise RuntimeError("Backend exited before becoming ready")
                if time.monotonic() >= deadline:
                    raise RuntimeError("Backend did not become ready within 30 seconds")
                time.sleep(0.1)
        print(f"Aelys backend: {origin}", flush=True)
        print(f"Aelys web: http://127.0.0.1:{web_port}", flush=True)
        web = None
        if start_web and not self.stop_signal:
            assert pnpm is not None  # Validated before starting either process.
            web = self.spawn(
                [
                    pnpm,
                    "--filter",
                    "@aelys/web",
                    "exec",
                    "vite",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(web_port),
                    "--strictPort",
                ],
                self.root,
                {**self.env, "AELYS_BACKEND_ORIGIN": origin},
            )
        elif not start_web:
            print("Using existing Aelys web server with the same backend", flush=True)
        while self.children:
            if self.stop_signal:
                return 128 + self.stop_signal
            if backend is not None and backend.poll() is not None:
                raise RuntimeError("Backend stopped; closing the owned frontend")
            if web is not None and (status := web.poll()) is not None:
                return status if status >= 0 else 128 - status
            time.sleep(0.1)
        return 0

    def run(self) -> int:
        previous = {}
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, self.on_signal)
        try:
            return self.launch()
        except (OSError, RuntimeError, ValueError) as error:
            if self.stop_signal:
                return 128 + self.stop_signal
            print(f"Aelys launch failed: {error}", file=sys.stderr, flush=True)
            return 1
        finally:
            self.cleanup()
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    def on_signal(self, signum: int, _frame: FrameType | None) -> None:
        # Record instead of raising during Popen construction so a new child is
        # always registered before shutdown begins.
        self.stop_signal = signum


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    return LocalLauncher(Path(__file__).resolve().parent.parent, dict(os.environ)).run()


if __name__ == "__main__":
    sys.exit(main())
