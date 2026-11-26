#!/usr/bin/env python3
"""
FastAPI backend for Matrix Multiplication Benchmark Workbench (Google Colab Pro + Tunneling).
Uses a PTY on Linux/Colab for zero-buffering realtime streaming of ./matmul_benchmark:
- Emits `plan` (total steps & N list)
- Emits `step_start` at the exact millisecond each kernel starts (via std::flush)
- Emits `record` immediately as each algorithm finishes so charts draw live
- Emits `hybrid` live during 4-step CPU/GPU micro-benchmarking & alpha* tuning
- Emits `done` with final CSV records + downloadable .xls/.csv/.html flags
"""

from __future__ import annotations

import csv
import json
import os
import platform
import queue
import re
import select
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import pty
except ImportError:  # Windows fallback
    pty = None  # type: ignore

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = Path(os.environ.get("MATMUL_REPO_DIR", ".")).resolve()
if not (REPO_DIR / "matmul_benchmark").exists() and (BASE_DIR.parent / "matmul_benchmark").exists():
    REPO_DIR = BASE_DIR.parent

BINARY_NAME = "matmul_benchmark.exe" if os.name == "nt" else "matmul_benchmark"
DIST_DIR = BASE_DIR / "dist"
INDEX_HTML = DIST_DIR / "index.html" if (DIST_DIR / "index.html").exists() else BASE_DIR / "index.html"

app = FastAPI(title="MatMul Bench API", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
if (DIST_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")


class RunRequest(BaseModel):
    sizes: List[int] = Field(default=[512, 1024, 2048], min_length=1, max_length=12)
    threads: List[int] = Field(default=[1, 2, 4, 8], min_length=1, max_length=12)
    runs: int = Field(default=3, ge=1, le=20)
    cuda_tile: int = Field(default=16)
    gpu_only: bool = Field(default=False)
    reset_hybrid_cfg: bool = Field(default=False)


class EventBus:
    """Stores events both in a queue (SSE) and an indexed list (unbuffered polling)."""

    def __init__(self) -> None:
        self._q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self._log: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def put(self, item: Optional[Dict[str, Any]]) -> None:
        if item is not None:
            with self._lock:
                self._log.append(item)
        self._q.put(item)

    def get(self, timeout: float = 8.0) -> Optional[Dict[str, Any]]:
        return self._q.get(timeout=timeout)

    def slice_from(self, cursor: int) -> Tuple[List[Dict[str, Any]], int]:
        with self._lock:
            n = len(self._log)
            c = max(0, min(cursor, n))
            return list(self._log[c:]), n


class BenchmarkJob:
    def __init__(
        self,
        job_id: str,
        cmd: List[str],
        cwd: Path,
        plan: Dict[str, Any],
        gpu_cuda_cores: int = 2560,
    ):
        self.job_id = job_id
        self.cmd = cmd
        self.cwd = cwd
        self.plan = plan
        self.gpu_cuda_cores = gpu_cuda_cores
        self.events = EventBus()
        self.process: Optional[subprocess.Popen] = None
        self.cancelled = False
        self.finished = False
        self.exit_code: Optional[int] = None
        self.hybrid_runs: List[Dict[str, Any]] = []
        self._current_hybrid: Optional[Dict[str, Any]] = None
        # Live parser tracking state
        self.current_n: int = plan["sizes"][0] if plan["sizes"] else 0
        self.current_threads: int = 1
        self.completed_steps: int = 0
        self.record_seq: int = 0
        self.active_step_emitted: Optional[str] = None
        self.started_at: float = time.time()


JOBS: Dict[str, BenchmarkJob] = {}
JOBS_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Hardware & File Parsing Helpers
# ---------------------------------------------------------------------------
def get_binary_path() -> Path:
    for candidate in (REPO_DIR / BINARY_NAME, BASE_DIR / BINARY_NAME, Path.cwd() / BINARY_NAME):
        if candidate.exists():
            return candidate
    return REPO_DIR / BINARY_NAME


def detect_hardware_info() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "os": f"{platform.system()} {platform.release()}",
        "cpu": platform.processor() or "Unknown CPU",
        "logical_cores": os.cpu_count() or 1,
        "physical_cores": max(1, (os.cpu_count() or 2) // 2),
        "ram_gb": 0.0,
        "gpu": "Không phát hiện GPU CUDA",
        "vram_mb": 0,
        "compute_cap": "",
        "cuda_cores": 0,
        "has_gpu": False,
        "binary_ready": get_binary_path().exists(),
        "repo_dir": str(REPO_DIR),
    }

    if Path("/etc/os-release").exists():
        try:
            for line in Path("/etc/os-release").read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("PRETTY_NAME="):
                    info["os"] = line.split("=", 1)[1].strip().strip('"')
                    break
        except OSError:
            pass

    if Path("/proc/cpuinfo").exists():
        try:
            text = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore")
            m_model = re.search(r"^model name\s*:\s*(.+)$", text, re.MULTILINE)
            if m_model:
                info["cpu"] = m_model.group(1).strip()
            m_cores = re.search(r"^cpu cores\s*:\s*(\d+)$", text, re.MULTILINE)
            if m_cores:
                info["physical_cores"] = int(m_cores.group(1))
        except OSError:
            pass

    if Path("/proc/meminfo").exists():
        try:
            text = Path("/proc/meminfo").read_text(encoding="utf-8", errors="ignore")
            m_ram = re.search(r"^MemTotal:\s*(\d+)\s+kB", text, re.MULTILINE)
            if m_ram:
                info["ram_gb"] = round(int(m_ram.group(1)) / (1024 * 1024), 2)
        except OSError:
            pass

    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,compute_cap",
                "--format=csv,noheader,nounits",
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=4,
        ).strip()
        if out:
            first = [p.strip() for p in out.splitlines()[0].split(",")]
            if len(first) >= 3:
                info["gpu"] = first[0]
                info["vram_mb"] = int(float(first[1]))
                info["compute_cap"] = first[2]
                info["has_gpu"] = True
                # Estimate CUDA cores for common Colab GPUs (actual count also read from binary stdout)
                g_low = first[0].lower()
                if "t4" in g_low:
                    info["cuda_cores"] = 2560
                elif "l4" in g_low:
                    info["cuda_cores"] = 7424
                elif "a100" in g_low:
                    info["cuda_cores"] = 6912
                elif "v100" in g_low:
                    info["cuda_cores"] = 5120
                else:
                    info["cuda_cores"] = 2560
    except Exception:
        pass

    return info


def detect_algo_key(name: str) -> str:
    s = (name or "").lower()
    if "tuan tu" in s or "baseline" in s or "seq" in s:
        return "seq"
    if "co ban" in s or "basic" in s:
        return "omp_basic"
    if "bypass" in s:
        return "omp_bypass"
    if "tiled" in s and "cuda" not in s:
        return "omp_l2_l3"
    if "ket hop" in s or "hybrid" in s or "cpu + cuda" in s:
        return "hybrid"
    if "global" in s:
        return "cuda_global"
    if "shared" in s:
        return "cuda_shared"
    return "omp_basic"


def parse_results_csv(csv_path: Path) -> List[Dict[str, Any]]:
    if not csv_path.exists():
        return []
    records: List[Dict[str, Any]] = []
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for idx, row in enumerate(reader, start=1):
                try:
                    n_val = int(float(row.get("KichThuoc_N") or row.get("N") or 0))
                    threads = int(float(row.get("SoLuong_Luong_q") or row.get("Threads") or 1))
                    algo_name = (row.get("ThuatToan") or "").strip()
                    t_sec = float(row.get("ThoiGian_s") or 0.0)
                    gflops = float(row.get("HieuNang_GFLOPS") or 0.0)
                    speedup = float(row.get("TangToc_Speedup") or 1.0)
                    verified = "fail" not in (row.get("KiemDinh") or "PASSED").lower()
                    if n_val > 0 and t_sec > 0:
                        records.append(
                            {
                                "id": idx,
                                "n": n_val,
                                "threads": threads,
                                "key": detect_algo_key(algo_name),
                                "algo": algo_name,
                                "time": t_sec,
                                "gflops": gflops,
                                "speedup": speedup,
                                "verified": verified,
                            }
                        )
                except ValueError:
                    continue
    except OSError:
        return []
    return records


def parse_hybrid_cfg(cfg_path: Path) -> List[Dict[str, Any]]:
    if not cfg_path.exists():
        return []
    entries: List[Dict[str, Any]] = []
    try:
        for line in cfg_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            item: Dict[str, Any] = {}
            for tok in line.split("|"):
                if "=" in tok:
                    k, v = tok.split("=", 1)
                    item[k.strip()] = v.strip()
            if "alpha" in item:
                entries.append(
                    {
                        "cpu": item.get("cpu", ""),
                        "gpu": item.get("gpu", ""),
                        "threads": int(item.get("threads", 1)),
                        "cuda_tile": int(item.get("cuda_tile", 16)),
                        "alpha": float(item.get("alpha", 0.8)),
                        "imbalance": float(item.get("imbalance", 1.0)),
                    }
                )
    except Exception:
        return []
    return entries


def build_execution_plan(
    sizes: List[int],
    threads: List[int],
    gpu_only: bool,
    has_gpu: bool,
    logical_cores: int,
) -> Dict[str, Any]:
    """Mirror src/main.cpp's run_standard_benchmark_suite step count for accurate progress."""
    eff_threads = list(threads)
    if logical_cores not in eff_threads and eff_threads and eff_threads[-1] < logical_cores:
        eff_threads.append(logical_cores)
        eff_threads.sort()

    per_size: Dict[str, int] = {}
    total = 0
    for n in sizes:
        cur_t = [8, 16] if n >= 2048 else eff_threads
        cnt = 0
        if not gpu_only and n < 2048:
            cnt += 1  # Sequential baseline
        if not gpu_only:
            cnt += len(cur_t) * (4 if has_gpu else 3)
        elif has_gpu:
            cnt += len(cur_t)  # Hybrid only per thread
        if has_gpu:
            cnt += 2  # CUDA Global + CUDA Shared
        per_size[str(n)] = cnt
        total += cnt

    return {
        "sizes": sizes,
        "threads": eff_threads,
        "gpu_only": gpu_only,
        "has_gpu": has_gpu,
        "per_size": per_size,
        "total_steps": max(1, total),
    }


# ---------------------------------------------------------------------------
# Realtime Stdout Parsers (matching src/main.cpp & src/algorithms.cpp)
# ---------------------------------------------------------------------------
RE_CUDA_CORES = re.compile(r"Tong nhan CUDA\s*:\s*(\d+)\s+CUDA Cores")
RE_MATRIX_N = re.compile(r"DANG THUC HIEN MA TRAN KICH THUOC N\s*=\s*(\d+)")
RE_THREADS = re.compile(r"---\s*So luong:\s*(\d+)\s*Cores/Threads")

# Flushed start prompts (arrive BEFORE newline while kernel runs!)
START_PROMPTS: List[Tuple[re.Pattern, str, str, str]] = [
    (re.compile(r"\[1/7\]\s*Chay Tuan tu Baseline"), "seq", "Tuần tự Baseline", "compute"),
    (re.compile(r"\[Kiem dinh\]\s*Tao C_ref"), "ref", "Tạo ma trận kiểm chứng C_ref", "prep"),
    (re.compile(r"\+\s*OpenMP Co ban\s*:"), "omp_basic", "OpenMP Cơ bản", "compute"),
    (re.compile(r"\+\s*OpenMP Tiled L2\+L3\s*:"), "omp_l2_l3", "OpenMP Tiled L2+L3", "compute"),
    (re.compile(r"\+\s*OpenMP Bypass L2\s*:"), "omp_bypass", "OpenMP Bypass L2", "compute"),
    (re.compile(r"\+\s*CPU \+ CUDA GPU\s*:"), "hybrid", "Hybrid CPU + CUDA", "compute"),
    (re.compile(r"\+\s*CUDA Global Memory\s*:"), "cuda_global", "CUDA Global Memory", "compute"),
    (re.compile(r"\+\s*CUDA Shared Memory Tiling\s*:"), "cuda_shared", "CUDA Shared Tiling", "compute"),
]

# Completed result lines
RE_SEQ_DONE = re.compile(r"Chay Tuan tu Baseline.*?Xong\s*\(([\d.]+)s,\s*([\d.]+)\s*GFLOPS\)")
RE_ALGO_DONE = re.compile(
    r"\+\s*(OpenMP Co ban|OpenMP Tiled L2\+L3|OpenMP Bypass L2|CPU \+ CUDA GPU|CUDA Global Memory|CUDA Shared Memory Tiling)\s*:\s*([\d.]+)s\s*\|\s*([\d.]+)\s*GFLOPS\s*\|\s*Speedup:\s*([\d.]+)x"
)

# Hybrid calibration lines
RE_HYB_START = re.compile(r"Dang do hieu chinh ti le chia tai \((\d+) CPU \+ 1 GPU thread, Tile (\d+)\)")
RE_HYB_STEP1 = re.compile(
    r"Buoc 1 \(N=(\d+)\): CPU = ([\d.]+) GFLOPS \(([\d.]+)s\) \| GPU = ([\d.]+) GFLOPS \(([\d.]+)s\)"
)
RE_HYB_STEP2 = re.compile(r"Buoc 2 \(Alpha0\): alpha0 = ([\d.]+)")
RE_HYB_STEP3 = re.compile(
    r"Buoc 3 \(Vong (\d+)\): M_GPU=(\d+), M_CPU=(\d+) \| t_GPU=([\d.]+)s, t_CPU=([\d.]+)s \| Imbalance=([\d.]+)"
)
RE_HYB_DONE = re.compile(r"Chot alpha\* = ([\d.]+) \(Imbalance=([\d.]+)\)")
RE_HYB_CACHED = re.compile(r"Nap alpha\* = ([\d.]+) \(Imbalance=([\d.]+)\)")


def emit_step_start_if_matched(job: BenchmarkJob, pending_text: str) -> None:
    """Detect flushed start prompt BEFORE newline so UI highlights active kernel immediately."""
    for pat, key, label, phase in START_PROMPTS:
        if pat.search(pending_text):
            threads = (
                job.gpu_cuda_cores
                if key in ("cuda_global", "cuda_shared")
                else (1 if key == "seq" else job.current_threads)
            )
            sig = f"{job.current_n}:{threads}:{key}:{job.completed_steps}"
            if job.active_step_emitted != sig:
                job.active_step_emitted = sig
                job.events.put(
                    {
                        "type": "step_start",
                        "n": job.current_n,
                        "threads": threads,
                        "key": key,
                        "label": label,
                        "phase": phase,
                        "completed": job.completed_steps,
                        "total": job.plan["total_steps"],
                    }
                )
            return


def process_complete_line(job: BenchmarkJob, line: str) -> None:
    job.events.put({"type": "log", "line": line})

    m = RE_CUDA_CORES.search(line)
    if m:
        job.gpu_cuda_cores = int(m.group(1))
        return

    m = RE_MATRIX_N.search(line)
    if m:
        job.current_n = int(m.group(1))
        job.active_step_emitted = None
        job.events.put(
            {
                "type": "size_start",
                "n": job.current_n,
                "completed": job.completed_steps,
                "total": job.plan["total_steps"],
            }
        )
        return

    m = RE_THREADS.search(line)
    if m:
        job.current_threads = int(m.group(1))
        return

    # Sequential baseline finished
    m = RE_SEQ_DONE.search(line)
    if m:
        job.completed_steps += 1
        job.record_seq += 1
        job.active_step_emitted = None
        t_sec = float(m.group(1))
        gflops = float(m.group(2))
        if t_sec <= 0.0 and gflops > 0.0 and job.current_n > 0:
            t_sec = (2.0 * (job.current_n ** 3)) / (gflops * 1e9)
        job.events.put(
            {
                "type": "record",
                "record": {
                    "id": job.record_seq,
                    "n": job.current_n,
                    "threads": 1,
                    "key": "seq",
                    "time": max(1e-6, t_sec),
                    "gflops": gflops,
                    "speedup": 1.0,
                    "verified": True,
                },
                "completed": job.completed_steps,
                "total": job.plan["total_steps"],
            }
        )
        return

    # Any parallel / hybrid / CUDA kernel finished
    m = RE_ALGO_DONE.search(line)
    if m:
        raw_name = m.group(1)
        key = detect_algo_key(raw_name)
        t_sec = float(m.group(2))
        gflops = float(m.group(3))
        speedup = float(m.group(4))
        if t_sec <= 0.0 and gflops > 0.0 and job.current_n > 0:
            t_sec = (2.0 * (job.current_n ** 3)) / (gflops * 1e9)
        threads = job.gpu_cuda_cores if key in ("cuda_global", "cuda_shared") else job.current_threads
        job.completed_steps += 1
        job.record_seq += 1
        job.active_step_emitted = None
        job.events.put(
            {
                "type": "record",
                "record": {
                    "id": job.record_seq,
                    "n": job.current_n,
                    "threads": threads,
                    "key": key,
                    "time": max(1e-6, t_sec),
                    "gflops": gflops,
                    "speedup": speedup,
                    "verified": True,
                },
                "completed": job.completed_steps,
                "total": job.plan["total_steps"],
            }
        )
        return

    # Hybrid tuning lines
    m = RE_HYB_START.search(line)
    if m:
        job._current_hybrid = {
            "cpu_threads": int(m.group(1)),
            "cuda_tile": int(m.group(2)),
            "calib_n": 1024,
            "perf_cpu": None,
            "t_cpu_cal": None,
            "perf_gpu": None,
            "t_gpu_cal": None,
            "alpha0": None,
            "iterations": [],
            "alpha_star": None,
            "imbalance": None,
            "from_cache": False,
        }
        job.events.put(
            {
                "type": "step_start",
                "n": job.current_n,
                "threads": job.current_threads,
                "key": "hybrid",
                "label": f"Chấm điểm CPU–GPU (Hybrid α*, {m.group(1)}C + GPU)",
                "phase": "calibrate",
                "completed": job.completed_steps,
                "total": job.plan["total_steps"],
            }
        )
        job.events.put({"type": "hybrid", "data": dict(job._current_hybrid)})
        return

    m = RE_HYB_STEP1.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid.update(
            {
                "calib_n": int(m.group(1)),
                "perf_cpu": float(m.group(2)),
                "t_cpu_cal": float(m.group(3)),
                "perf_gpu": float(m.group(4)),
                "t_gpu_cal": float(m.group(5)),
            }
        )
        job.events.put({"type": "hybrid", "data": dict(job._current_hybrid)})
        return

    m = RE_HYB_STEP2.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid["alpha0"] = float(m.group(1))
        job.events.put({"type": "hybrid", "data": dict(job._current_hybrid)})
        return

    m = RE_HYB_STEP3.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid["iterations"].append(
            {
                "round": int(m.group(1)),
                "m_gpu": int(m.group(2)),
                "m_cpu": int(m.group(3)),
                "t_gpu": float(m.group(4)),
                "t_cpu": float(m.group(5)),
                "imbalance": float(m.group(6)),
            }
        )
        job.events.put({"type": "hybrid", "data": dict(job._current_hybrid)})
        return

    m = RE_HYB_DONE.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid["alpha_star"] = float(m.group(1))
        job._current_hybrid["imbalance"] = float(m.group(2))
        snap = dict(job._current_hybrid)
        job.hybrid_runs.append(snap)
        job._current_hybrid = None
        job.events.put({"type": "hybrid", "data": snap})
        return

    m = RE_HYB_CACHED.search(line)
    if m:
        entry = {
            "alpha_star": float(m.group(1)),
            "imbalance": float(m.group(2)),
            "from_cache": True,
            "iterations": [],
        }
        job.hybrid_runs.append(entry)
        job.events.put({"type": "hybrid", "data": entry})


def worker_run(job: BenchmarkJob) -> None:
    job.events.put({"type": "plan", "plan": job.plan})

    master_fd = None
    slave_fd = None
    try:
        if pty is not None and os.name == "posix":
            # PTY tricks glibc into line-buffering + immediate flush on Linux/Colab!
            master_fd, slave_fd = pty.openpty()
            proc = subprocess.Popen(
                job.cmd,
                cwd=str(job.cwd),
                stdin=subprocess.DEVNULL,
                stdout=slave_fd,
                stderr=slave_fd,
                close_fds=True,
            )
            os.close(slave_fd)
            slave_fd = None
            job.process = proc

            buf = ""
            while True:
                rlist, _, _ = select.select([master_fd], [], [], 0.2)
                if rlist:
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
                    buf += text
                    while "\n" in buf:
                        line, buf = buf.split("\n", 1)
                        process_complete_line(job, line)
                    if buf:
                        emit_step_start_if_matched(job, buf)
                elif proc.poll() is not None:
                    # Drain any remaining bytes
                    try:
                        while True:
                            r2, _, _ = select.select([master_fd], [], [], 0.05)
                            if not r2:
                                break
                            chunk = os.read(master_fd, 4096)
                            if not chunk:
                                break
                            buf += chunk.decode("utf-8", errors="replace").replace("\r\n", "\n")
                    except OSError:
                        pass
                    break

            if buf.strip():
                process_complete_line(job, buf.strip())
            proc.wait()
            job.exit_code = proc.returncode
        else:
            proc = subprocess.Popen(
                job.cmd,
                cwd=str(job.cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                errors="replace",
            )
            job.process = proc
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                process_complete_line(job, raw_line.rstrip("\r\n"))
            proc.wait()
            job.exit_code = proc.returncode
    except Exception as exc:
        job.exit_code = -1
        job.events.put({"type": "log", "line": f"[ERROR] {exc}"})
    finally:
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass

        job.finished = True
        csv_records = parse_results_csv(job.cwd / "benchmark_results.csv")
        cfg_entries = parse_hybrid_cfg(job.cwd / "hybrid_alpha.cfg")
        job.events.put(
            {
                "type": "done",
                "exit_code": job.exit_code,
                "cancelled": job.cancelled,
                "elapsed_sec": round(time.time() - job.started_at, 2),
                "records": csv_records,
                "hybrid_cfg": cfg_entries,
                "hybrid_runs": job.hybrid_runs,
                "files": {
                    "csv": (job.cwd / "benchmark_results.csv").exists(),
                    "xls": (job.cwd / "benchmark_results.xls").exists(),
                    "html": (job.cwd / "benchmark_charts.html").exists(),
                    "cfg": (job.cwd / "hybrid_alpha.cfg").exists(),
                },
            }
        )
        job.events.put(None)


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def serve_ui():
    if not INDEX_HTML.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    return HTMLResponse(INDEX_HTML.read_text(encoding="utf-8"))


@app.get("/api/hardware")
def api_hardware():
    hw = detect_hardware_info()
    cwd = get_binary_path().parent
    return {
        "mode": "live",
        "hardware": hw,
        "hybrid_cfg": parse_hybrid_cfg(cwd / "hybrid_alpha.cfg"),
        "files": {
            "csv": (cwd / "benchmark_results.csv").exists(),
            "xls": (cwd / "benchmark_results.xls").exists(),
            "html": (cwd / "benchmark_charts.html").exists(),
            "cfg": (cwd / "hybrid_alpha.cfg").exists(),
        },
    }


@app.get("/api/results")
def api_results():
    cwd = get_binary_path().parent
    return {
        "records": parse_results_csv(cwd / "benchmark_results.csv"),
        "hybrid_cfg": parse_hybrid_cfg(cwd / "hybrid_alpha.cfg"),
    }


@app.post("/api/run")
def api_run(req: RunRequest):
    binary = get_binary_path()
    if not binary.exists():
        raise HTTPException(
            status_code=400,
            detail=f"Chưa tìm thấy binary {binary}. Hãy chạy `make CUDA_ENABLED=1` trước.",
        )

    if req.cuda_tile not in (16, 32):
        raise HTTPException(status_code=400, detail="cuda_tile chỉ nhận 16 hoặc 32.")

    clean_sizes = sorted({n for n in req.sizes if 64 <= n <= 16384})
    clean_threads = sorted({t for t in req.threads if 1 <= t <= 128})
    if not clean_sizes or not clean_threads:
        raise HTTPException(status_code=400, detail="Danh sách N và Threads không hợp lệ.")

    cwd = binary.parent
    if req.reset_hybrid_cfg:
        cfg_file = cwd / "hybrid_alpha.cfg"
        if cfg_file.exists():
            try:
                cfg_file.unlink()
            except OSError:
                pass

    cmd = [
        str(binary),
        "-N",
        ",".join(str(x) for x in clean_sizes),
        "-t",
        ",".join(str(x) for x in clean_threads),
        "-r",
        str(req.runs),
        "--cuda-tile",
        str(req.cuda_tile),
        "-o",
        "benchmark_results.csv",
    ]
    if req.gpu_only:
        cmd.append("--gpu-only")

    hw = detect_hardware_info()
    plan = build_execution_plan(
        clean_sizes,
        clean_threads,
        req.gpu_only,
        hw["has_gpu"],
        hw["logical_cores"],
    )

    job_id = uuid.uuid4().hex[:12]
    job = BenchmarkJob(
        job_id=job_id,
        cmd=cmd,
        cwd=cwd,
        plan=plan,
        gpu_cuda_cores=hw["cuda_cores"] or 2560,
    )
    with JOBS_LOCK:
        JOBS[job_id] = job

    threading.Thread(target=worker_run, args=(job,), daemon=True).start()
    return {"job_id": job_id, "command": " ".join(cmd), "plan": plan}


@app.get("/api/job/{job_id}")
def api_job_poll(job_id: str, cursor: int = 0):
    """Unbuffered incremental JSON polling — immune to Cloudflare Tunnel SSE buffering."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")
    events, next_cursor = job.events.slice_from(cursor)
    return {
        "events": events,
        "next_cursor": next_cursor,
        "finished": job.finished,
        "exit_code": job.exit_code,
    }


@app.get("/api/stream/{job_id}")
def api_stream(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")

    def event_generator():
        # Initial 2KB comment forces edge proxies/Cloudflare to flush chunked stream immediately
        yield ":" + (" " * 2048) + "\n\n"
        while True:
            try:
                item = job.events.get(timeout=8.0)
            except queue.Empty:
                yield ": keepalive\n\n"
                if job.finished:
                    break
                continue
            if item is None:
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/cancel/{job_id}")
def api_cancel(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")
    job.cancelled = True
    if job.process and job.process.poll() is None:
        try:
            job.process.terminate()
        except OSError:
            pass
    return {"cancelled": True}


@app.get("/api/download/{fmt}")
def api_download(fmt: str):
    cwd = get_binary_path().parent
    mapping = {
        "csv": ("benchmark_results.csv", "text/csv"),
        "xls": ("benchmark_results.xls", "application/vnd.ms-excel"),
        "html": ("benchmark_charts.html", "text/html"),
        "cfg": ("hybrid_alpha.cfg", "text/plain"),
    }
    if fmt not in mapping:
        raise HTTPException(status_code=404, detail="Định dạng không hỗ trợ.")
    filename, media_type = mapping[fmt]
    target = cwd / filename
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Chưa có file {filename}. Hãy chạy benchmark trước.")
    return FileResponse(path=str(target), filename=filename, media_type=media_type)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
