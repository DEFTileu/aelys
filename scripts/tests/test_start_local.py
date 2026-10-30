"""Exercise the real launcher against isolated HTTP servers and process trees."""

import importlib.util
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).with_name("local_worker.py")
spec = importlib.util.spec_from_file_location(
    "start_local", ROOT / "scripts/start_local.py"
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def eventually(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    assert predicate(), "condition did not become true before timeout"


def running(pid):
    # A killed descendant may briefly remain a zombie owned by launchd/init.
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")


@pytest.fixture
def project(tmp_path):
    for directory in ("scripts", "backend", ".venv/bin", "bin", "state"):
        (tmp_path / directory).mkdir(parents=True, exist_ok=True)
    for name in ("start_local.sh", "start_local.py"):
        shutil.copy2(ROOT / "scripts" / name, tmp_path / "scripts" / name)
    for name, mode in ((".venv/bin/uvicorn", "backend"), ("bin/pnpm", "web")):
        script = tmp_path / name
        script.write_text(
            f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(WORKER))} {mode} "$@"\n'
        )
        script.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{tmp_path / 'bin'}:{os.environ['PATH']}",
        "AELYS_TEST_STATE": str(tmp_path / "state"),
        "AELYS_BACKEND_PORT": str(free_port()),
        "AELYS_WEB_PORT": str(free_port()),
    }
    env.pop("AELYS_BACKEND_ORIGIN", None)
    processes = []

    def start(**updates):
        process = subprocess.Popen(
            ["bash", str(tmp_path / "scripts/start_local.sh")],
            env={**env, **updates},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        processes.append(process)
        return process

    def pid(mode):
        path = tmp_path / "state" / f"{mode}.pid"
        eventually(lambda: path.exists() and bool(path.read_text()))
        if mode == "descendant":
            eventually(lambda: (tmp_path / "state/descendant.ready").exists())
        return int(path.read_text())

    yield tmp_path, env, start, pid, processes
    for process in processes:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=7)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    for path in (tmp_path / "state").glob("*.pid"):
        child = int(path.read_text())
        if running(child):
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize("stop_signal", [signal.SIGTERM, signal.SIGINT])
def test_shutdown_closes_owned_backend_frontend_and_term_resistant_descendant(
    project, stop_signal
):
    _, _, start, pid, _ = project
    process = start()
    owned = [pid(mode) for mode in ("backend", "web", "descendant")]
    process.send_signal(stop_signal)
    assert process.wait(timeout=7) == 128 + stop_signal
    for child in owned:
        eventually(lambda child=child: not running(child))


def test_frontend_failure_is_propagated_and_backend_is_closed(project):
    _, _, start, pid, _ = project
    process = start(AELYS_TEST_WEB_EXIT="9")
    backend = pid("backend")
    assert process.wait(timeout=7) == 9
    eventually(lambda: not running(backend))


def test_backend_failure_closes_frontend_tree(project):
    root, _, start, pid, _ = project
    process = start()
    owned = [pid(mode) for mode in ("backend", "web", "descendant")]
    (root / "state/stop-backend").touch()
    assert process.wait(timeout=7) == 1
    for child in owned:
        eventually(lambda child=child: not running(child))


def test_reused_backend_survives_frontend_shutdown(project):
    _, env, start, pid, processes = project
    backend = subprocess.Popen(
        [sys.executable, str(WORKER), "backend", "--port", env["AELYS_BACKEND_PORT"]],
        env=env,
    )
    processes.append(backend)
    origin = f"http://127.0.0.1:{env['AELYS_BACKEND_PORT']}"
    eventually(lambda: launcher.backend_is_aelys(origin))
    process = start()
    web, descendant = pid("web"), pid("descendant")
    process.terminate()
    assert process.wait(timeout=7) == 143
    eventually(lambda: not running(web) and not running(descendant))
    assert backend.poll() is None


@pytest.mark.parametrize("matches", [True, False])
def test_reuses_only_frontend_with_matching_backend(project, matches):
    _, env, start, _, processes = project
    backend = subprocess.Popen(
        [sys.executable, str(WORKER), "backend", "--port", env["AELYS_BACKEND_PORT"]],
        env=env,
    )
    processes.append(backend)
    origin = f"http://127.0.0.1:{env['AELYS_BACKEND_PORT']}"
    eventually(lambda: launcher.backend_is_aelys(origin))
    web_backend = origin if matches else "http://127.0.0.1:1"
    web = subprocess.Popen(
        [sys.executable, str(WORKER), "web", "--port", env["AELYS_WEB_PORT"]],
        env={**env, "AELYS_BACKEND_ORIGIN": web_backend},
    )
    processes.append(web)
    eventually(lambda: launcher.web_is_aelys(int(env["AELYS_WEB_PORT"]), web_backend))
    assert launcher.web_is_aelys(int(env["AELYS_WEB_PORT"]), origin) is matches
    process = start()
    assert process.wait(timeout=5) == (0 if matches else 1)
    assert backend.poll() is None and web.poll() is None
    assert ("Using existing" in process.stdout.read()) == matches


def test_shutdown_while_backend_is_starting(project):
    root, _, start, pid, _ = project
    process = start(AELYS_TEST_BACKEND_WAIT="1")
    backend = pid("backend")
    process.terminate()
    assert process.wait(timeout=7) == 143
    eventually(lambda: not running(backend))
    assert not (root / "state/web.pid").exists()


def test_owned_backend_with_reused_web_stays_supervised(project):
    _, env, start, pid, processes = project
    origin = f"http://127.0.0.1:{env['AELYS_BACKEND_PORT']}"
    web = subprocess.Popen(
        [sys.executable, str(WORKER), "web", "--port", env["AELYS_WEB_PORT"]],
        env={**env, "AELYS_BACKEND_ORIGIN": origin},
    )
    processes.append(web)
    eventually(lambda: launcher.web_is_aelys(int(env["AELYS_WEB_PORT"]), origin))
    process = start()
    backend = pid("backend")
    eventually(lambda: launcher.backend_is_aelys(origin))
    assert process.poll() is None
    process.terminate()
    assert process.wait(timeout=7) == 143
    eventually(lambda: not running(backend))
    assert web.poll() is None


def test_backend_startup_failure_does_not_launch_frontend(project):
    root, _, start, pid, _ = project
    process = start(AELYS_TEST_BACKEND_EXIT="1")
    backend = pid("backend")
    assert process.wait(timeout=5) == 1
    eventually(lambda: not running(backend))
    assert not (root / "state/web.pid").exists()


def test_generic_healthy_service_is_not_a_backend(project):
    _, env, start, _, processes = project
    generic = subprocess.Popen(
        [sys.executable, str(WORKER), "generic", "--port", env["AELYS_BACKEND_PORT"]],
        env=env,
    )
    processes.append(generic)
    origin = f"http://127.0.0.1:{env['AELYS_BACKEND_PORT']}"
    eventually(lambda: launcher.read_json(f"{origin}/healthz"))
    assert not launcher.backend_is_aelys(origin)
    process = start()
    assert process.wait(timeout=5) == 1
    assert generic.poll() is None


@pytest.mark.parametrize("value", ["0", "65536", "bad", "-1"])
def test_invalid_ports_fail_before_spawning(project, value):
    root, _, start, _, _ = project
    process = start(AELYS_BACKEND_PORT=value)
    assert process.wait(timeout=5) == 1
    assert not list((root / "state").glob("*.pid"))


@pytest.mark.parametrize(
    "value",
    [
        "https://owner:private@example.test",
        "https://example.test/path",
        "https://example.test?token=private",
        "http://example.test\n",
    ],
)
def test_invalid_origin_is_rejected_without_echoing_secret(value):
    with pytest.raises(ValueError) as error:
        launcher.backend_origin(value)
    assert "private" not in str(error.value)
