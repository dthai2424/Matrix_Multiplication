#!/usr/bin/env python3
"""
FastAPI backend for Matrix Multiplication Benchmark Workbench (Google Colab + Tunneling).
Runs ./matmul_benchmark, streams live stdout/stderr & Hybrid alpha* tuning via SSE,
and serves results + .csv / .xls / .html downloads.
"""

from __future__ import annotations

import csv
import json
import os
import platform
import queue
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
REPO_DIR = Path(os.environ.get("MATMUL_REPO_DIR", ".")).resolve()
if not (REPO_DIR / "matmul_benchmark").exists() and (BASE_DIR.parent / "matmul_benchmark").exists():
    REPO_DIR = BASE_DIR.parent

BINARY_NAME = "matmul_benchmark.exe" if os.name == "nt" else "matmul_benchmark"
INDEX_HTML = BASE_DIR / "index.html"

app = FastAPI(title="MatMul Bench API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    sizes: List[int] = Field(default=[512, 1024, 2048, 4096], min_length=1, max_length=12)
    threads: List[int] = Field(default=[1, 2, 4, 8, 16], min_length=1, max_length=12)
    runs: int = Field(default=3, ge=1, le=20)
    cuda_tile: int = Field(default=16)
    gpu_only: bool = Field(default=False)
    reset_hybrid_cfg: bool = Field(default=False)


class BenchmarkJob:
    def __init__(self, job_id: str, cmd: List[str], cwd: Path):
        self.job_id = job_id
        self.cmd = cmd
        self.cwd = cwd
        self.events: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
        self.process: Optional[subprocess.Popen] = None
        self.cancelled = False
        self.finished = False
        self.exit_code: Optional[int] = None
        self.hybrid_runs: List[Dict[str, Any]] = []
        self._current_hybrid: Optional[Dict[str, Any]] = None


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
        "binary_ready": get_binary_path().exists(),
        "repo_dir": str(REPO_DIR),
    }

    # Linux OS name, CPU model, physical cores, RAM
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

    # NVIDIA GPU via nvidia-smi
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
    if "ket hop" in s or "hybrid" in s:
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


# Regexes matching src/algorithms.cpp verbose Hybrid output
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


def parse_hybrid_stdout_line(job: BenchmarkJob, line: str) -> Optional[Dict[str, Any]]:
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
        return job._current_hybrid

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
        return job._current_hybrid

    m = RE_HYB_STEP2.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid["alpha0"] = float(m.group(1))
        return job._current_hybrid

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
        return job._current_hybrid

    m = RE_HYB_DONE.search(line)
    if m and job._current_hybrid is not None:
        job._current_hybrid["alpha_star"] = float(m.group(1))
        job._current_hybrid["imbalance"] = float(m.group(2))
        job.hybrid_runs.append(job._current_hybrid)
        snap = dict(job._current_hybrid)
        job._current_hybrid = None
        return snap

    m = RE_HYB_CACHED.search(line)
    if m:
        entry = {
            "alpha_star": float(m.group(1)),
            "imbalance": float(m.group(2)),
            "from_cache": True,
            "iterations": [],
        }
        job.hybrid_runs.append(entry)
        return entry

    return None


def worker_run(job: BenchmarkJob) -> None:
    try:
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
            line = raw_line.rstrip("\r\n")
            job.events.put({"type": "log", "line": line})
            hyb_update = parse_hybrid_stdout_line(job, line)
            if hyb_update is not None:
                job.events.put({"type": "hybrid", "data": hyb_update})

        proc.wait()
        job.exit_code = proc.returncode
    except Exception as exc:
        job.exit_code = -1
        job.events.put({"type": "log", "line": f"[ERROR] {exc}"})
    finally:
        job.finished = True
        csv_records = parse_results_csv(job.cwd / "benchmark_results.csv")
        cfg_entries = parse_hybrid_cfg(job.cwd / "hybrid_alpha.cfg")
        job.events.put(
            {
                "type": "done",
                "exit_code": job.exit_code,
                "cancelled": job.cancelled,
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

    job_id = uuid.uuid4().hex[:12]
    job = BenchmarkJob(job_id=job_id, cmd=cmd, cwd=cwd)
    with JOBS_LOCK:
        JOBS[job_id] = job

    threading.Thread(target=worker_run, args=(job,), daemon=True).start()
    return {"job_id": job_id, "command": " ".join(cmd)}


@app.get("/api/stream/{job_id}")
def api_stream(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job.")

    def event_generator():
        while True:
            try:
                item = job.events.get(timeout=10.0)
            except queue.Empty:
                # Keepalive comment prevents Cloudflare Tunnel 100s idle timeout
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
            "Cache-Control": "no-cache",
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
