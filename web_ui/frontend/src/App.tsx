import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Database,
  Download,
  Filter,
  ListChecks,
  Maximize2,
  Minimize2,
  Moon,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { ALGO_META, ALGO_ORDER, computeMetrics, DEFAULT_HYBRID, detectAlgoKey, PRESETS, SAMPLE_RECORDS } from './data';
import type {
  ActiveStep,
  AlgoGroup,
  AlgoKey,
  BenchmarkRecord,
  ChartMetric,
  ExecutionPlan,
  HardwareInfo,
  HybridState,
  MainTab,
  PresetId,
} from './types';
import { AnimatedNumber } from './components/AnimatedNumber';
import { EChartPanel, type ChartKind, type EChartPanelHandle } from './components/EChartPanel';
import { HybridPanel } from './components/HybridPanel';
import { TablesPanel } from './components/TablesPanel';

function fmtStopwatch(ms: number): string {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${rem}`;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(text: string): BenchmarkRecord[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const h = splitCsvLine(lines[0]).map((x) => x.toLowerCase());
  const iN = h.findIndex((x) => x.includes('kichthuoc_n') || x === 'n');
  const iT = h.findIndex((x) => x.includes('luong') || x.includes('thread'));
  const iA = h.findIndex((x) => x.includes('thuattoan') || x.includes('algo'));
  const iS = h.findIndex((x) => x === 'thoigian_s' || x.includes('time'));
  const iP = h.findIndex((x) => x.includes('kiemdinh') || x.includes('verified'));
  const raw: Omit<BenchmarkRecord, 'gflops' | 'speedup'>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const n = Number(c[iN]);
    const time = Number(c[iS]);
    if (n > 0 && time > 0) {
      raw.push({
        id: i,
        n,
        threads: Number(c[iT]) || 1,
        key: detectAlgoKey(c[iA] || ''),
        time,
        verified: iP >= 0 ? !String(c[iP]).toLowerCase().includes('fail') : true,
      });
    }
  }
  return computeMetrics(raw);
}

export function App() {
  // Theme
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Backend & Hardware
  const [liveBackend, setLiveBackend] = useState(false);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [hasXls, setHasXls] = useState(false);

  // Benchmark Data & Hybrid State
  const [records, setRecords] = useState<BenchmarkRecord[]>(SAMPLE_RECORDS);
  const [hybrid, setHybrid] = useState<HybridState>(DEFAULT_HYBRID);

  // Configuration State (1:1 honest mapping to ./matmul_benchmark CLI flags)
  const [preset, setPreset] = useState<PresetId>('quick');
  const [sizes, setSizes] = useState<number[]>(PRESETS.quick.sizes);
  const [customNText, setCustomNText] = useState('');
  const [threads, setThreads] = useState<number[]>(PRESETS.quick.threads);
  const [runs, setRuns] = useState<number>(PRESETS.quick.runs);
  const [cudaTile, setCudaTile] = useState<16 | 32>(16);
  const [selectedAlgos, setSelectedAlgos] = useState<AlgoKey[]>(PRESETS.quick.algos);
  const [resetHybridCfg, setResetHybridCfg] = useState<boolean>(true);

  // Popovers & Modals
  const [configOpen, setConfigOpen] = useState(false);
  const [algoPickerOpen, setAlgoPickerOpen] = useState(false);
  const [dataMenuOpen, setDataMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [fullscreenKind, setFullscreenKind] = useState<ChartKind | null>(null);
  const [copiedCli, setCopiedCli] = useState(false);

  // Navigation & Chart Controls
  const [mainTab, setMainTab] = useState<MainTab>('charts');
  const [metric, setMetric] = useState<ChartMetric>('live_split');
  const [logScaleByKind, setLogScaleByKind] = useState<Record<'gflops' | 'time' | 'speedup', boolean>>({
    gflops: false, // Default Linear for immediate projector impact (20-50x gap)
    time: true,    // Default Log10 for 1000x time dynamic range
    speedup: false,
  });
  const [forceBar, setForceBar] = useState(false);
  const [hiddenAlgos, setHiddenAlgos] = useState<Set<AlgoKey>>(new Set());
  const [threadN, setThreadN] = useState<number | null>(null);

  // Live Execution State
  const [isRunning, setIsRunning] = useState(false);
  const [showTracker, setShowTracker] = useState(false);
  const [plan, setPlan] = useState<ExecutionPlan | null>(null);
  const [activeStep, setActiveStep] = useState<ActiveStep | null>(null);
  const [completedSteps, setCompletedSteps] = useState(0);
  const [doneBySize, setDoneBySize] = useState<Record<number, number>>({});
  const [finishBanner, setFinishBanner] = useState<string>('');
  const [consoleLog, setConsoleLog] = useState<string>('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stepElapsedMs, setStepElapsedMs] = useState(0);

  const jobIdRef = useRef<string | null>(null);
  const pollStopRef = useRef<boolean>(false);
  const runStartRef = useRef<number>(0);
  const activeStepRef = useRef<ActiveStep | null>(null);
  const mainChartRef = useRef<EChartPanelHandle>(null);
  const splitLeftRef = useRef<EChartPanelHandle>(null);
  const splitRightRef = useRef<EChartPanelHandle>(null);
  const fsChartRef = useRef<EChartPanelHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Probe Colab FastAPI backend on boot
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/api/hardware', { cache: 'no-store' });
        if (!res.ok) throw new Error('offline');
        const data = await res.json();
        if (!mounted) return;
        setLiveBackend(true);
        setHardware(data.hardware);
        setHasXls(Boolean(data.files?.xls));

        const rRes = await fetch('/api/results');
        if (rRes.ok) {
          const rData = await rRes.json();
          if (rData.records?.length) setRecords(computeMetrics(rData.records));
          if (rData.hybrid_cfg?.length) {
            const last = rData.hybrid_cfg[rData.hybrid_cfg.length - 1];
            setHybrid((prev) => ({
              ...prev,
              alpha_star: last.alpha,
              imbalance: last.imbalance,
              from_cache: true,
            }));
          }
        }
      } catch {
        if (!mounted) return;
        setLiveBackend(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Stopwatch ticker while running
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => {
      const now = performance.now();
      setElapsedMs(now - runStartRef.current);
      if (activeStepRef.current) {
        setStepElapsedMs(now - activeStepRef.current.startedAtMs);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [isRunning]);

  // Keyboard shortcuts: F to toggle Fullscreen Inspect, Esc to close popovers/modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setFullscreenKind(null);
        setConfigOpen(false);
        setAlgoPickerOpen(false);
        setDataMenuOpen(false);
        setFilterOpen(false);
        setLogOpen(false);
      } else if ((e.key === 'f' || e.key === 'F') && mainTab === 'charts') {
        e.preventDefault();
        setFullscreenKind((prev) => {
          if (prev) return null;
          if (metric === 'gflops' || metric === 'time' || metric === 'speedup' || metric === 'threads') {
            return metric;
          }
          return 'gflops';
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mainTab, metric]);

  // Effective sorted N list (chips + custom N)
  const effectiveSizes = useMemo(() => {
    const s = new Set(sizes);
    if (customNText.trim()) {
      customNText.split(',').forEach((tok) => {
        const v = parseInt(tok.trim(), 10);
        if (v >= 64 && v <= 16384) s.add(v);
      });
    }
    return [...s].sort((a, b) => a - b);
  }, [sizes, customNText]);

  const cliCommand = useMemo(() => {
    const parts = ['./matmul_benchmark'];
    if (effectiveSizes.length) parts.push(`-N ${effectiveSizes.join(',')}`);
    if (threads.length) parts.push(`-t ${threads.join(',')}`);
    parts.push(`-r ${runs}`, `--cuda-tile ${cudaTile}`);
    if (selectedAlgos.length < ALGO_ORDER.length) {
      parts.push(`--algos ${selectedAlgos.join(',')}`);
    }
    return parts.join(' ');
  }, [effectiveSizes, threads, runs, cudaTile, selectedAlgos]);

  const uniqueMeasuredN = useMemo(
    () => [...new Set(records.map((r) => r.n))].sort((a, b) => a - b),
    [records]
  );

  useEffect(() => {
    if (uniqueMeasuredN.length && (threadN === null || !uniqueMeasuredN.includes(threadN))) {
      const multi = uniqueMeasuredN.find(
        (n) => records.filter((r) => r.n === n && ALGO_META[r.key].group === 'cpu').length >= 2
      );
      setThreadN(multi ?? uniqueMeasuredN[uniqueMeasuredN.length - 1]);
    }
  }, [uniqueMeasuredN, records, threadN]);

  // KPI Metrics
  const kpi = useMemo(() => {
    if (!records.length) {
      return {
        peakGflops: 0,
        peakLabel: 'Chưa có dữ liệu',
        maxSpeedup: 0,
        speedupLabel: '—',
        passCount: 0,
        totalCount: 0,
        ratio: 0,
        maxN: 0,
        bestAtMax: '—',
      };
    }
    const bG = records.reduce((a, b) => (b.gflops > a.gflops ? b : a));
    const bS = records.reduce((a, b) => (b.speedup > a.speedup ? b : a));
    const passCount = records.filter((r) => r.verified).length;
    const maxN = uniqueMeasuredN[uniqueMeasuredN.length - 1];
    const atMax = records.filter((r) => r.n === maxN);
    const cpus = atMax.filter((r) => ALGO_META[r.key].group === 'cpu');
    const gpus = atMax.filter((r) => ALGO_META[r.key].group !== 'cpu');
    const bCpu = cpus.length ? cpus.reduce((a, b) => (b.gflops > a.gflops ? b : a)) : null;
    const bGpu = gpus.length ? gpus.reduce((a, b) => (b.gflops > a.gflops ? b : a)) : null;
    const ratio = bCpu && bGpu ? bGpu.gflops / bCpu.gflops : 0;
    return {
      peakGflops: bG.gflops,
      peakLabel: `${ALGO_META[bG.key].shortName} · N=${bG.n}`,
      maxSpeedup: bS.speedup,
      speedupLabel: `${ALGO_META[bS.key].shortName} · N=${bS.n}`,
      passCount,
      totalCount: records.length,
      ratio,
      maxN,
      bestAtMax: ALGO_META[(bGpu || bCpu || bG).key].shortName,
    };
  }, [records, uniqueMeasuredN]);

  // Preset Selection
  const applyPreset = (id: 'quick' | 'gpu' | 'full') => {
    const p = PRESETS[id];
    setPreset(id);
    setSizes(p.sizes);
    setCustomNText('');
    setThreads(p.threads);
    setRuns(p.runs);
    setCudaTile(p.cudaTile);
    setSelectedAlgos(p.algos);
  };

  const toggleRunAlgo = (k: AlgoKey) => {
    setPreset('custom');
    setSelectedAlgos((prev) => {
      if (prev.includes(k)) {
        return prev.length > 1 ? prev.filter((x) => x !== k) : prev;
      }
      return ALGO_ORDER.filter((x) => x === k || prev.includes(x));
    });
  };

  const toggleSizeChip = (n: number) => {
    setPreset('custom');
    setSizes((prev) => {
      if (prev.includes(n)) return prev.length > 1 ? prev.filter((x) => x !== n) : prev;
      return [...prev, n].sort((a, b) => a - b);
    });
  };

  const toggleThreadChip = (t: number) => {
    setPreset('custom');
    setThreads((prev) => {
      if (prev.includes(t)) return prev.length > 1 ? prev.filter((x) => x !== t) : prev;
      return [...prev, t].sort((a, b) => a - b);
    });
  };

  const toggleAlgoHidden = (k: AlgoKey) => {
    setHiddenAlgos((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const toggleGroupVisibility = (grp: AlgoGroup) => {
    const groupKeys = ALGO_ORDER.filter((k) => ALGO_META[k].group === grp);
    const allHidden = groupKeys.every((k) => hiddenAlgos.has(k));
    setHiddenAlgos((prev) => {
      const next = new Set(prev);
      groupKeys.forEach((k) => {
        if (allHidden) next.delete(k);
        else next.add(k);
      });
      return next;
    });
  };

  // Run Benchmark (Unbuffered 200ms JSON Polling on Colab Pro — immune to Cloudflare SSE buffering!)
  const stopRun = async () => {
    pollStopRef.current = true;
    if (jobIdRef.current) {
      try {
        await fetch(`/api/cancel/${jobIdRef.current}`, { method: 'POST' });
      } catch {
        // ignore
      }
    }
    jobIdRef.current = null;
    activeStepRef.current = null;
    setActiveStep(null);
    setIsRunning(false);
    setFinishBanner('Đã dừng thực nghiệm theo yêu cầu');
  };

  const startRun = async () => {
    if (isRunning || !effectiveSizes.length || !threads.length || !selectedAlgos.length) return;
    pollStopRef.current = false;
    setConfigOpen(false);
    setAlgoPickerOpen(false);
    setMainTab('charts');
    if (metric === 'threads') setMetric('live_split');
    setShowTracker(true);
    setFinishBanner('');
    setConsoleLog('');
    setRecords([]);
    setCompletedSteps(0);
    setDoneBySize({});
    setElapsedMs(0);
    setStepElapsedMs(0);
    runStartRef.current = performance.now();
    setIsRunning(true);

    if (liveBackend) {
      try {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sizes: effectiveSizes,
            threads,
            runs,
            cuda_tile: cudaTile,
            algos: selectedAlgos,
            reset_hybrid_cfg: resetHybridCfg,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: res.statusText }));
          throw new Error(err.detail || 'Lỗi khởi chạy backend');
        }
        const { job_id, command, plan: serverPlan } = await res.json();
        jobIdRef.current = job_id;
        setPlan(serverPlan);
        setConsoleLog(`$ ${command}\n`);

        let cursor = 0;
        let doneReceived = false;

        while (!pollStopRef.current && !doneReceived) {
          try {
            const pRes = await fetch(`/api/job/${job_id}?cursor=${cursor}`, { cache: 'no-store' });
            if (!pRes.ok) throw new Error(`HTTP ${pRes.status}`);
            const batch = await pRes.json();
            cursor = batch.next_cursor ?? cursor;

            const newLogs: string[] = [];
            const newRecords: BenchmarkRecord[] = [];
            let latestCompleted: number | null = null;
            const sizeIncrements: Record<number, number> = {};

            for (const msg of batch.events || []) {
              if (msg.type === 'plan' && msg.plan) {
                setPlan(msg.plan);
              } else if (msg.type === 'size_start') {
                const st: ActiveStep = {
                  n: msg.n,
                  threads: 0,
                  key: 'ref',
                  label: `Chuẩn bị ma trận N = ${msg.n}`,
                  phase: 'prep',
                  startedAtMs: performance.now(),
                };
                activeStepRef.current = st;
                setActiveStep(st);
                setStepElapsedMs(0);
              } else if (msg.type === 'step_start') {
                const st: ActiveStep = {
                  n: msg.n,
                  threads: msg.threads,
                  key: msg.key,
                  label: msg.label,
                  phase: msg.phase,
                  startedAtMs: performance.now(),
                };
                activeStepRef.current = st;
                setActiveStep(st);
                setStepElapsedMs(0);
              } else if (msg.type === 'record' && msg.record) {
                newRecords.push(msg.record);
                latestCompleted = msg.completed || 0;
                sizeIncrements[msg.record.n] = (sizeIncrements[msg.record.n] || 0) + 1;
              } else if (msg.type === 'log') {
                newLogs.push(msg.line);
              } else if (msg.type === 'hybrid' && msg.data) {
                setHybrid((prev) => ({ ...prev, ...msg.data }));
              } else if (msg.type === 'done') {
                doneReceived = true;
                jobIdRef.current = null;
                activeStepRef.current = null;
                setActiveStep(null);
                setIsRunning(false);
                if (msg.records?.length) {
                  const parsed = computeMetrics(msg.records);
                  setRecords(parsed);
                  setCompletedSteps(parsed.length);
                  const byN: Record<number, number> = {};
                  parsed.forEach((r) => {
                    byN[r.n] = (byN[r.n] || 0) + 1;
                  });
                  setDoneBySize(byN);
                }
                if (msg.files?.xls) setHasXls(true);
                if (msg.hybrid_runs?.length) {
                  setHybrid((prev) => ({ ...prev, ...msg.hybrid_runs[msg.hybrid_runs.length - 1] }));
                }
                setFinishBanner(
                  msg.exit_code === 0
                    ? `Hoàn tất ${msg.records?.length || 0} bài đo trong ${msg.elapsed_sec || 0}s`
                    : `Kết thúc (mã thoát ${msg.exit_code})`
                );
              }
            }

            if (newLogs.length) {
              setConsoleLog((prev) => prev + newLogs.join('\n') + '\n');
            }
            if (!doneReceived && newRecords.length) {
              setRecords((prev) => computeMetrics([...prev, ...newRecords]));
              if (latestCompleted !== null) setCompletedSteps(latestCompleted);
              setDoneBySize((prev) => {
                const next = { ...prev };
                for (const [k, v] of Object.entries(sizeIncrements)) {
                  const nk = Number(k);
                  next[nk] = (next[nk] || 0) + v;
                }
                return next;
              });
            }

            if (batch.finished && !doneReceived) {
              doneReceived = true;
              setIsRunning(false);
            }
          } catch {
            // Brief transient network glitch over tunnel — retry on next tick
          }

          if (!doneReceived && !pollStopRef.current) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      } catch (err: any) {
        setConsoleLog((prev) => prev + `[ERROR] ${err.message}\n`);
        setIsRunning(false);
        setFinishBanner(`Lỗi: ${err.message}`);
      }
      return;
    }

    // Offline Interactive Demo Mode (demonstrates incremental bar rise per completed algorithm)
    const simAlgos: AlgoKey[] = selectedAlgos;
    const tasks: { n: number; threads: number; key: AlgoKey }[] = [];
    const perSize: Record<string, number> = {};
    effectiveSizes.forEach((n) => {
      let c = 0;
      simAlgos.forEach((k) => {
        if (k === 'seq') {
          if (n < 2048) {
            tasks.push({ n, threads: 1, key: k });
            c++;
          }
        } else if (k === 'cuda_global' || k === 'cuda_shared') {
          tasks.push({ n, threads: 2560, key: k });
          c++;
        } else {
          const ts = n >= 2048 ? threads.filter((t) => t >= 8) : threads;
          (ts.length ? ts : [threads[threads.length - 1] || 8]).forEach((t) => {
            tasks.push({ n, threads: t, key: k });
            c++;
          });
        }
      });
      perSize[String(n)] = c;
    });

    setPlan({
      sizes: effectiveSizes,
      threads,
      algos: selectedAlgos,
      gpu_only: !selectedAlgos.some((k) => ALGO_META[k].group === 'cpu'),
      has_gpu: true,
      per_size: perSize,
      total_steps: tasks.length,
    });
    setConsoleLog(`$ ${cliCommand}\n[Offline Demo] Mô phỏng tiến trình đo trực tiếp...\n`);

    const simG = (n: number, t: number, k: AlgoKey) => {
      const j = 0.94 + Math.random() * 0.12;
      const sN = Math.min(1.2, 0.72 + Math.log2(n / 256) * 0.13);
      if (k === 'seq') return 6.0 * j;
      if (k === 'omp_basic') return 2.6 * Math.pow(t, 0.56) * (n <= 512 ? 0.95 : 1.15) * j;
      if (k === 'omp_l2_l3') return 2.1 * Math.pow(t, 0.58) * (n >= 1024 ? 1.25 : 0.75) * j;
      if (k === 'omp_bypass') return 2.2 * Math.pow(t, 0.57) * (n >= 1024 ? 1.22 : 0.78) * j;
      if (k === 'hybrid') return (16 + 3.2 * Math.min(t, 16) * 0.75) * sN * (cudaTile === 32 ? 1.05 : 1) * j;
      if (k === 'cuda_global') return 58 * Math.pow(n / 512, 0.42) * j;
      return 64 * Math.pow(n / 512, 0.45) * (cudaTile === 32 ? 1.08 : 1) * j;
    };

    let seqId = 1;
    for (let i = 0; i < tasks.length; i++) {
      const tk = tasks[i];
      const st: ActiveStep = {
        n: tk.n,
        threads: tk.threads,
        key: tk.key,
        label: ALGO_META[tk.key].name,
        phase: 'compute',
        startedAtMs: performance.now(),
      };
      activeStepRef.current = st;
      setActiveStep(st);
      setStepElapsedMs(0);

      // Give enough visual time (~220ms) so live-growing time bar is clearly visible in demo
      await new Promise((r) => setTimeout(r, Math.max(120, Math.min(280, 2600 / tasks.length))));

      const g = simG(tk.n, tk.threads, tk.key);
      const time = (2.0 * tk.n ** 3) / (g * 1e9);
      const rec = { id: seqId++, n: tk.n, threads: tk.threads, key: tk.key, time, verified: true };
      setRecords((prev) => computeMetrics([...prev, rec]));
      setCompletedSteps(i + 1);
      setDoneBySize((prev) => ({ ...prev, [tk.n]: (prev[tk.n] || 0) + 1 }));
      setConsoleLog(
        (prev) =>
          prev + `[${i + 1}/${tasks.length}] N=${tk.n} ${ALGO_META[tk.key].name} (${tk.threads}T): ${time.toFixed(4)}s · ${g.toFixed(1)} GFLOPS\n`
      );
    }

    activeStepRef.current = null;
    setActiveStep(null);
    setIsRunning(false);
    setFinishBanner(`Hoàn tất mô phỏng ${tasks.length} bài đo`);
  };

  const exportCsv = () => {
    setDataMenuOpen(false);
    if (liveBackend) {
      window.location.href = '/api/download/csv';
      return;
    }
    const header = 'STT,KichThuoc_N,SoLuong_Luong_q,ThuatToan,ThoiGian_s,HieuNang_GFLOPS,TangToc_Speedup,KiemDinh';
    const rows = records.map(
      (r, i) =>
        `${i + 1},${r.n},${r.threads},"${ALGO_META[r.key].csvName}",${r.time.toFixed(6)},${r.gflops.toFixed(2)},${r.speedup.toFixed(2)},${r.verified ? 'PASSED' : 'FAILED'}`
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' }));
    a.download = 'benchmark_results.csv';
    a.click();
  };

  const activeScaleKind: 'gflops' | 'time' | 'speedup' | null =
    metric === 'gflops' || metric === 'time' || metric === 'speedup' ? metric : null;

  const progressPct = plan?.total_steps
    ? Math.min(100, Math.round((completedSteps / plan.total_steps) * 100))
    : 0;

  return (
    <div className="min-h-screen flex flex-col">
      {/* 1. TOPBAR (52px, full-width responsive, bold LIVE hardware status for projector) */}
      <header className="sticky top-0 z-30 h-[52px] bg-[var(--surface)] border-b border-[var(--border)] flex items-center">
        <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 xl:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="shrink-0">
              <rect x="2" y="2" width="6.5" height="6.5" rx="1" fill="currentColor" />
              <rect x="11.5" y="2" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="11.5" width="6.5" height="6.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
              <rect x="11.5" y="11.5" width="6.5" height="6.5" rx="1" fill="var(--accent)" />
            </svg>
            <span className="text-[15px] font-bold tracking-tight whitespace-nowrap">MatMul Bench</span>

            {liveBackend && hardware ? (
              <div className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 rounded border border-[var(--ok)]/40 bg-[var(--ok)]/10 text-xs font-semibold truncate">
                <span className="w-2 h-2 rounded-full bg-[var(--ok)] shrink-0" />
                <span className="text-[var(--ok)]">LIVE</span>
                <span className="text-[var(--ink)] truncate">
                  {hardware.gpu} ({Math.round(hardware.vram_mb / 1024)}GB) · {hardware.logical_cores} vCPU · {hardware.ram_gb.toFixed(0)}GB RAM
                </span>
              </div>
            ) : (
              <div className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1 rounded border border-[var(--border)] bg-[var(--subtle)] text-xs font-medium text-[var(--muted)]">
                <span className="w-2 h-2 rounded-full bg-[var(--muted)] shrink-0" />
                Chế độ xem trước tĩnh (Offline)
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 relative">
            {/* Unified Data Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setDataMenuOpen((o) => !o);
                  setConfigOpen(false);
                  setAlgoPickerOpen(false);
                  setFilterOpen(false);
                }}
                className="btn-interactive h-9 px-3 rounded-md border border-[var(--border)] bg-transparent text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer hover:bg-[var(--subtle)]"
              >
                <Database className="w-3.5 h-3.5" />
                <span>Dữ liệu</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {dataMenuOpen && (
                <div className="anim-drawer absolute right-0 mt-1.5 w-52 rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1 z-40">
                  {hasXls && (
                    <a
                      href="/api/download/xls"
                      download
                      onClick={() => setDataMenuOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-[var(--subtle)] text-[var(--ink)] no-underline"
                    >
                      <Download className="w-3.5 h-3.5 text-[var(--accent)]" />
                      Tải báo cáo Excel (.xls)
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={exportCsv}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-[var(--subtle)] text-left cursor-pointer bg-transparent border-0 text-[var(--ink)]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Xuất file CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDataMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-[var(--subtle)] text-left cursor-pointer bg-transparent border-0 text-[var(--ink)]"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Import benchmark_results.csv
                  </button>
                  {!liveBackend && (
                    <button
                      type="button"
                      onClick={() => {
                        setRecords(SAMPLE_RECORDS);
                        setDataMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium hover:bg-[var(--subtle)] text-left cursor-pointer bg-transparent border-0 text-[var(--ink)] border-t border-[var(--border-soft)]"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Khôi phục dữ liệu mẫu
                    </button>
                  )}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const rd = new FileReader();
                  rd.onload = () => {
                    const parsed = parseCsv(String(rd.result || ''));
                    if (parsed.length) setRecords(parsed);
                  };
                  rd.readAsText(f);
                  e.target.value = '';
                }}
              />
            </div>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
              aria-label="Chuyển giao diện sáng tối"
              className="btn-interactive h-9 w-9 rounded-md border border-[var(--border)] bg-transparent inline-flex items-center justify-center cursor-pointer hover:bg-[var(--subtle)]"
            >
              {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      {/* 2. SINGLE COMMAND BAR (3 1-Click Presets + Honest Scope Toggle + Config Popover + Primary Run CTA) */}
      <div className="bg-[var(--surface)] border-b border-[var(--border)] relative z-20">
        <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 xl:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* 3 One-Click Demo Presets */}
            <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--subtle)] p-0.5" role="group" aria-label="Kịch bản thực nghiệm nhanh">
              {(['quick', 'gpu', 'full'] as const).map((pid) => (
                <button
                  key={pid}
                  type="button"
                  disabled={isRunning}
                  onClick={() => applyPreset(pid)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded cursor-pointer transition-colors disabled:opacity-50 ${
                    preset === pid
                      ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs'
                      : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  {PRESETS[pid].label}
                </button>
              ))}
            </div>

            {/* Per-Algorithm Checkbox Picker (1:1 matches --algos CLI flag) */}
            <div className="relative">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => {
                  setAlgoPickerOpen((o) => !o);
                  setConfigOpen(false);
                  setDataMenuOpen(false);
                  setFilterOpen(false);
                }}
                aria-expanded={algoPickerOpen}
                className={`btn-interactive h-[34px] px-3 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                  algoPickerOpen || selectedAlgos.length < ALGO_ORDER.length
                    ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--subtle)]'
                    : 'border-[var(--border)] text-[var(--ink)] bg-[var(--surface)] hover:bg-[var(--subtle)]'
                }`}
              >
                <ListChecks className="w-3.5 h-3.5" />
                <span>
                  Thuật toán ({selectedAlgos.length}/{ALGO_ORDER.length})
                </span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {algoPickerOpen && (
                <div className="anim-drawer absolute left-0 mt-1.5 w-72 rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-xl p-3 space-y-2.5 z-40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--ink)]">Chọn thuật toán sẽ chạy</span>
                    <span className="text-[11px] font-mono text-[var(--muted)]">
                      {selectedAlgos.length}/{ALGO_ORDER.length}
                    </span>
                  </div>

                  {/* Quick-select helpers */}
                  <div className="flex flex-wrap gap-1 pb-2 border-b border-[var(--border-soft)]">
                    {(
                      [
                        ['Tất cả', ALGO_ORDER],
                        ['Chỉ CPU', ['seq', 'omp_basic', 'omp_l2_l3', 'omp_bypass'] as AlgoKey[]],
                        ['Chỉ GPU', ['cuda_global', 'cuda_shared'] as AlgoKey[]],
                        ['Tiêu biểu', ['omp_l2_l3', 'hybrid', 'cuda_shared'] as AlgoKey[]],
                      ] as const
                    ).map(([label, keys]) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => {
                          setPreset('custom');
                          setSelectedAlgos([...keys]);
                        }}
                        className="px-2 py-1 rounded border border-[var(--border)] bg-[var(--subtle)] hover:border-[var(--ink)] text-[11px] font-semibold text-[var(--ink)] cursor-pointer"
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Grouped Checkboxes */}
                  <div className="space-y-2">
                    {(
                      [
                        ['CPU (Tuần tự & OpenMP)', 'cpu'],
                        ['Dị thể (Hybrid)', 'hybrid'],
                        ['GPU (CUDA thuần)', 'gpu'],
                      ] as const
                    ).map(([grpTitle, grpKey]) => (
                      <div key={grpKey} className="space-y-0.5">
                        <div className="text-[11px] font-semibold text-[var(--muted)] px-1">{grpTitle}</div>
                        {ALGO_ORDER.filter((k) => ALGO_META[k].group === grpKey).map((k) => {
                          const m = ALGO_META[k];
                          const checked = selectedAlgos.includes(k);
                          const isLastSelected = checked && selectedAlgos.length === 1;
                          return (
                            <label
                              key={k}
                              className="flex items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-[var(--subtle)] cursor-pointer text-xs select-none"
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={isLastSelected}
                                  onChange={() => toggleRunAlgo(k)}
                                  className="accent-[var(--accent)]"
                                />
                                <span
                                  className="w-2.5 h-2.5 rounded-xs shrink-0"
                                  style={{ background: m.color }}
                                />
                                <span className="truncate font-medium text-[var(--ink)]">{m.name}</span>
                              </span>
                              {k === 'seq' && (
                                <span className="text-[10px] font-mono text-[var(--muted)] shrink-0">
                                  N&lt;2048
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>

                  <div className="pt-1.5 border-t border-[var(--border-soft)] flex items-center justify-between text-[11px] text-[var(--muted)]">
                    <span>Ánh xạ trực tiếp cờ --algos</span>
                    <button
                      type="button"
                      onClick={() => setAlgoPickerOpen(false)}
                      className="text-xs font-semibold text-[var(--accent)] hover:underline cursor-pointer bg-transparent border-0 p-0"
                    >
                      Xong
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Active config summary pill */}
            <span className="hidden lg:inline text-xs font-mono text-[var(--muted)]">
              N={effectiveSizes.join(',')} · {threads.join(',')}T · r={runs} · Tile {cudaTile}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Config Drawer Trigger */}
            <button
              type="button"
              onClick={() => {
                setConfigOpen((o) => !o);
                setAlgoPickerOpen(false);
                setDataMenuOpen(false);
                setFilterOpen(false);
              }}
              aria-expanded={configOpen}
              className={`btn-interactive h-10 px-3.5 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                configOpen
                  ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--subtle)]'
                  : 'border-[var(--border)] text-[var(--ink)] bg-transparent hover:bg-[var(--subtle)]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Tùy chỉnh</span>
            </button>

            {isRunning ? (
              <button
                type="button"
                onClick={stopRun}
                className="btn-interactive h-10 px-4 rounded-md border border-[var(--danger)] text-[var(--danger)] bg-transparent hover:bg-[var(--danger)]/10 text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Dừng</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={startRun}
                className="btn-interactive h-10 px-5 rounded-md bg-[var(--accent)] text-[var(--accent-ink)] border border-[var(--accent)] text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <span>Chạy thực nghiệm</span>
                <ArrowRight className="w-4 h-4 m-arrow" />
              </button>
            )}
          </div>
        </div>

        {/* Collapsible Progressive-Disclosure Configuration Drawer */}
        {configOpen && (
          <div className="anim-drawer border-t border-[var(--border)] bg-[var(--bg)]">
            <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 xl:px-8 py-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
              {/* Sizes N */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--ink)]">Kích thước ma trận (N × N)</div>
                <div className="flex flex-wrap gap-1.5">
                  {[256, 512, 1024, 2048, 4096].map((n) => {
                    const on = sizes.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => toggleSizeChip(n)}
                        className={`h-8 px-2.5 rounded text-xs font-semibold border cursor-pointer tabular ${
                          on
                            ? 'bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]'
                            : 'bg-[var(--surface)] text-[var(--muted)] border-[var(--border)] hover:border-[var(--ink)]'
                        }`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
                <input
                  type="text"
                  value={customNText}
                  onChange={(e) => {
                    setPreset('custom');
                    setCustomNText(e.target.value);
                  }}
                  placeholder="Thêm N tùy chọn (VD: 768, 1536)"
                  className="w-full h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs tabular"
                />
              </div>

              {/* CPU Threads */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-[var(--ink)]">
                  Số luồng CPU OpenMP
                  <span className="font-normal text-[var(--muted)] ml-1.5">(N ≥ 2048 dùng 8T &amp; 16T)</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 4, 8, 16].map((t) => {
                    const on = threads.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleThreadChip(t)}
                        className={`h-8 px-2.5 rounded text-xs font-semibold border cursor-pointer tabular ${
                          on
                            ? 'bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]'
                            : 'bg-[var(--surface)] text-[var(--muted)] border-[var(--border)] hover:border-[var(--ink)]'
                        }`}
                      >
                        {t}T
                      </button>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-xs text-[var(--muted)] pt-1 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={resetHybridCfg}
                    onChange={(e) => setResetHybridCfg(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  Đo lại điểm CPU/GPU mới (xóa cache hybrid_alpha.cfg)
                </label>
              </div>

              {/* Runs & CUDA Tile */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="cfgRuns" className="block text-xs font-semibold mb-1.5">
                    Số lần lặp (1–10)
                  </label>
                  <input
                    id="cfgRuns"
                    type="number"
                    min={1}
                    max={10}
                    value={runs}
                    onChange={(e) => {
                      setPreset('custom');
                      setRuns(Math.max(1, Math.min(10, Number(e.target.value) || 1)));
                    }}
                    className="w-full h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold tabular"
                  />
                </div>
                <div>
                  <label htmlFor="cfgTile" className="block text-xs font-semibold mb-1.5">
                    CUDA Shared Tile
                  </label>
                  <select
                    id="cfgTile"
                    value={cudaTile}
                    onChange={(e) => {
                      setPreset('custom');
                      setCudaTile(Number(e.target.value) as 16 | 32);
                    }}
                    className="w-full h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm font-semibold tabular"
                  >
                    <option value={16}>16 × 16</option>
                    <option value={32}>32 × 32</option>
                  </select>
                </div>
              </div>

              {/* Honest CLI Command Preview */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Lệnh CLI thực thi (1:1)</span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(cliCommand);
                      } catch {
                        // ignore
                      }
                      setCopiedCli(true);
                      setTimeout(() => setCopiedCli(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent)] hover:underline cursor-pointer bg-transparent border-0 p-0"
                  >
                    {copiedCli ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCli ? 'Đã chép' : 'Sao chép'}
                  </button>
                </div>
                <div className="px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] font-mono text-xs overflow-x-auto whitespace-nowrap">
                  {cliCommand}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MAIN CONTENT (Fluid Full Width, generous breathing space, ~80% for charts) */}
      <main className="flex-1 w-full max-w-[1920px] mx-auto px-4 sm:px-6 xl:px-8 py-5 space-y-5">
        {/* 3. PROJECTOR-GRADE WHITESPACE KPI STRIP (No heavy card borders, smooth AnimatedNumber) */}
        <section aria-label="Chỉ số hiệu năng nổi bật" className="grid grid-cols-2 lg:grid-cols-4 gap-4 pb-4 border-b border-[var(--border-soft)]">
          <div>
            <div className="text-xs font-semibold text-[var(--muted)]">Hiệu năng đỉnh</div>
            <div className="text-2xl sm:text-3xl font-bold tracking-tight mt-0.5 text-[var(--ink)]">
              <AnimatedNumber value={kpi.peakGflops} decimals={2} />
              <span className="text-sm font-medium text-[var(--muted)] ml-1.5">GFLOPS</span>
            </div>
            <div className="text-xs text-[var(--muted)] mt-0.5">{kpi.peakLabel}</div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[var(--muted)]">Tăng tốc tối đa</div>
            <div className="text-2xl sm:text-3xl font-bold tracking-tight mt-0.5 text-[var(--ink)]">
              <AnimatedNumber value={kpi.maxSpeedup} decimals={2} suffix="×" />
            </div>
            <div className="text-xs text-[var(--muted)] mt-0.5">{kpi.speedupLabel}</div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[var(--muted)]">Kiểm định Frobenius</div>
            <div className="text-2xl sm:text-3xl font-bold tracking-tight mt-0.5 text-[var(--ok)] tabular">
              {kpi.passCount} / {kpi.totalCount}
            </div>
            <div className="text-xs text-[var(--muted)] mt-0.5">
              {kpi.totalCount > 0 && kpi.passCount === kpi.totalCount ? 'Toàn vẹn số học (PASSED)' : 'Đang cập nhật'}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[var(--muted)]">
              GPU / CPU tại N={kpi.maxN || '—'}
            </div>
            <div className="text-2xl sm:text-3xl font-bold tracking-tight mt-0.5 text-[var(--accent)]">
              {kpi.ratio > 0 ? <AnimatedNumber value={kpi.ratio} decimals={1} suffix="×" /> : '—'}
            </div>
            <div className="text-xs text-[var(--muted)] mt-0.5">Nhanh nhất: {kpi.bestAtMax}</div>
          </div>
        </section>

        {/* 4. SINGLE UNIFIED LIVE EXECUTION STRIP (42px + inline N stepper + 2px progress bar + Log popover) */}
        {showTracker && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] overflow-hidden relative tabular">
            <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 min-w-0 text-sm">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    isRunning ? 'bg-[var(--accent)] anim-pulse' : 'bg-[var(--ok)]'
                  }`}
                />
                {isRunning && activeStep ? (
                  <span className="inline-flex items-center gap-2 font-semibold text-[var(--ink)] min-w-0">
                    <span className="truncate">
                      Đang chạy: N={activeStep.n}
                      {activeStep.threads > 0 &&
                        ` · ${activeStep.key === 'cuda_global' || activeStep.key === 'cuda_shared' ? 'GPU' : `${activeStep.threads}T`}`}
                      {' · '}
                      <span className="text-[var(--accent)]">{activeStep.label}</span>
                    </span>
                    <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded bg-[var(--accent)]/12 border border-[var(--accent)]/30 font-mono text-xs font-bold text-[var(--accent)] tabular">
                      {(stepElapsedMs / 1000).toFixed(1)}s
                    </span>
                  </span>
                ) : (
                  <span className="font-semibold text-[var(--ink)]">
                    {finishBanner || 'Đang chuẩn bị thực nghiệm...'}
                  </span>
                )}

                {/* Inline N Stepper (no heavy pill borders) */}
                {plan?.sizes?.length ? (
                  <div className="hidden md:flex items-center gap-2 text-xs pl-3 border-l border-[var(--border)]">
                    {plan.sizes.map((n, idx) => {
                      const expected = plan.per_size[String(n)] || 0;
                      const done = doneBySize[n] || 0;
                      const isDone = expected > 0 && done >= expected;
                      const isActive = isRunning && activeStep?.n === n && !isDone;
                      return (
                        <span key={n} className="inline-flex items-center gap-1">
                          {idx > 0 && <span className="text-[var(--border)]">→</span>}
                          <span
                            className={
                              isDone
                                ? 'text-[var(--ok)] font-semibold'
                                : isActive
                                ? 'text-[var(--accent)] font-bold'
                                : 'text-[var(--muted)]'
                            }
                          >
                            {isDone ? '✓' : isActive ? '●' : '○'} {n}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center gap-3 text-xs shrink-0">
                <span className="text-[var(--muted)] font-medium">
                  {completedSteps}/{plan?.total_steps || 0} ({progressPct}%)
                </span>
                <span className="font-mono font-bold text-[var(--ink)]">{fmtStopwatch(elapsedMs)}</span>
                <button
                  type="button"
                  onClick={() => setLogOpen((o) => !o)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--subtle)] font-semibold cursor-pointer bg-transparent text-[var(--ink)]"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Log</span>
                </button>
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() => setShowTracker(false)}
                    aria-label="Ẩn thanh tiến độ"
                    className="p-1 text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer bg-transparent border-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* 2px Progress Track */}
            <div className="w-full h-0.5 bg-[var(--subtle)]">
              <div
                className="h-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {/* Collapsible Live Console Log Drawer */}
            {logOpen && (
              <pre className="anim-drawer m-0 p-3 border-t border-[var(--border-soft)] bg-[var(--bg)] font-mono text-xs text-[var(--muted)] max-h-44 overflow-auto whitespace-pre-wrap leading-relaxed">
                {consoleLog || 'Chưa có log.'}
              </pre>
            )}
          </div>
        )}

        {/* 5. SINGLE 3-TAB AXIS + WORKSPACE STAGE */}
        <section className="rounded-md border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
          {/* Primary 3-Tab Header + Contextual Chart Toolbar */}
          <div className="px-4 sm:px-5 pt-2 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1" role="tablist" aria-label="Khu vực phân tích">
              {(
                [
                  ['charts', 'Biểu đồ'],
                  ['hybrid', 'Cân bằng Hybrid (α*)'],
                  ['table', 'Bảng dữ liệu'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mainTab === id}
                  onClick={() => setMainTab(id)}
                  className={`relative px-3.5 py-2.5 text-sm font-semibold cursor-pointer bg-transparent border-0 transition-colors ${
                    mainTab === id ? 'text-[var(--ink)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  {label}
                  {mainTab === id && (
                    <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--accent)]" />
                  )}
                </button>
              ))}
            </div>

            {/* Contextual Chart Controls (only visible on Biểu đồ tab) */}
            {mainTab === 'charts' && (
              <div className="flex flex-wrap items-center gap-2 pb-2">
                {/* Metric Switcher */}
                <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--subtle)] p-0.5">
                  {(
                    [
                      ['live_split', 'Live Split'],
                      ['gflops', 'GFLOPS'],
                      ['time', 'Thời gian'],
                      ['speedup', 'Speedup'],
                      ['threads', 'Luồng CPU'],
                      ['grid', 'Lưới 2×2'],
                    ] as const
                  ).map(([mId, mLbl]) => (
                    <button
                      key={mId}
                      type="button"
                      onClick={() => setMetric(mId)}
                      className={`px-2.5 py-1 text-xs font-semibold rounded cursor-pointer transition-colors ${
                        metric === mId
                          ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs'
                          : 'text-[var(--muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {mLbl}
                    </button>
                  ))}
                </div>

                {/* Linear / Log10 Toggle */}
                {(activeScaleKind || metric === 'live_split' || metric === 'grid') && (
                  <button
                    type="button"
                    onClick={() => {
                      const k = activeScaleKind ?? 'time';
                      setLogScaleByKind((prev) => ({ ...prev, [k]: !prev[k] }));
                    }}
                    className={`h-8 px-2.5 rounded-md border text-xs font-semibold cursor-pointer ${
                      logScaleByKind[activeScaleKind ?? 'time']
                        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--subtle)]'
                        : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--ink)] bg-transparent'
                    }`}
                  >
                    {logScaleByKind[activeScaleKind ?? 'time'] ? 'Thang Log10' : 'Thang Linear'}
                  </button>
                )}

                {/* Bar / Line Toggle when >= 2 N */}
                {activeScaleKind && uniqueMeasuredN.length >= 2 && (
                  <button
                    type="button"
                    onClick={() => setForceBar((b) => !b)}
                    className="h-8 px-2.5 rounded-md border border-[var(--border)] text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] bg-transparent cursor-pointer"
                  >
                    {forceBar ? 'Dạng Đường' : 'Dạng Thanh'}
                  </button>
                )}

                {/* Thread N selector */}
                {(metric === 'threads' || metric === 'grid') && uniqueMeasuredN.length > 0 && (
                  <select
                    aria-label="Chọn N cho Thread Scaling"
                    value={threadN ?? uniqueMeasuredN[uniqueMeasuredN.length - 1]}
                    onChange={(e) => setThreadN(Number(e.target.value))}
                    className="h-8 px-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold tabular"
                  >
                    {uniqueMeasuredN.map((n) => (
                      <option key={n} value={n}>
                        N = {n}
                      </option>
                    ))}
                  </select>
                )}

                {/* Compact Series Filter Popover (replaces 7 bordered chips!) */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setFilterOpen((o) => !o);
                      setConfigOpen(false);
                      setAlgoPickerOpen(false);
                      setDataMenuOpen(false);
                    }}
                    className={`h-8 px-2.5 rounded-md border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                      hiddenAlgos.size > 0
                        ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--subtle)]'
                        : 'border-[var(--border)] text-[var(--ink)] bg-transparent hover:bg-[var(--subtle)]'
                    }`}
                  >
                    <Filter className="w-3.5 h-3.5" />
                    <span>
                      Lọc ({ALGO_ORDER.length - hiddenAlgos.size}/{ALGO_ORDER.length})
                    </span>
                  </button>

                  {filterOpen && (
                    <div className="anim-drawer absolute right-0 mt-1.5 w-60 rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg p-2.5 space-y-2 z-40">
                      <div className="flex items-center justify-between pb-1.5 border-b border-[var(--border-soft)]">
                        <div className="flex gap-1.5">
                          {(['cpu', 'hybrid', 'gpu'] as const).map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() => toggleGroupVisibility(g)}
                              className="px-2 py-0.5 rounded border border-[var(--border)] text-xs font-semibold hover:bg-[var(--subtle)] cursor-pointer uppercase"
                            >
                              {g}
                            </button>
                          ))}
                        </div>
                        {hiddenAlgos.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setHiddenAlgos(new Set())}
                            className="text-xs font-semibold text-[var(--accent)] hover:underline cursor-pointer bg-transparent border-0 p-0"
                          >
                            Hiện hết
                          </button>
                        )}
                      </div>
                      <div className="space-y-1">
                        {ALGO_ORDER.map((k) => {
                          const m = ALGO_META[k];
                          const checked = !hiddenAlgos.has(k);
                          return (
                            <label
                              key={k}
                              className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--subtle)] cursor-pointer text-xs"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAlgoHidden(k)}
                                className="accent-[var(--accent)]"
                              />
                              <span className="w-2.5 h-2.5 rounded-xs shrink-0" style={{ background: m.color }} />
                              <span className="truncate">{m.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* HD PNG Export */}
                {metric !== 'grid' && metric !== 'live_split' && (
                  <button
                    type="button"
                    onClick={() => mainChartRef.current?.downloadPng(`matmul_${metric}.png`)}
                    className="h-8 px-2.5 rounded-md border border-[var(--border)] bg-transparent hover:bg-[var(--subtle)] text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>PNG</span>
                  </button>
                )}

                {/* Fullscreen / Focus Inspect Mode Button */}
                <button
                  type="button"
                  onClick={() => {
                    const target: ChartKind =
                      metric === 'gflops' || metric === 'time' || metric === 'speedup' || metric === 'threads'
                        ? metric
                        : 'gflops';
                    setFullscreenKind(target);
                  }}
                  title="Phóng to toàn màn hình để soi biểu đồ (phím F)"
                  className="h-8 px-2.5 rounded-md border border-[var(--border)] bg-transparent hover:bg-[var(--subtle)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Phóng to (F)</span>
                </button>
              </div>
            )}
          </div>

          {/* Stage Content */}
          <div className="p-4 sm:p-6">
            {mainTab === 'charts' && (
              <>
                {/* LIVE SPLIT: Side-by-side GFLOPS + Time Bars (crisp rise on completion) */}
                {metric === 'live_split' && (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-sm font-bold">
                            Hiệu năng tính toán (GFLOPS)
                            {isRunning && activeStep?.n ? ` · N = ${activeStep.n}` : ''}
                          </h2>
                          <p className="text-xs text-[var(--muted)]">
                            Cột hiện lên nhanh ngay khi từng thuật toán xong · Cao hơn tốt hơn
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => splitLeftRef.current?.downloadPng('matmul_gflops.png')}
                            className="h-7 px-2 rounded border border-[var(--border)] text-xs font-semibold hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                          >
                            PNG
                          </button>
                          <button
                            type="button"
                            onClick={() => setFullscreenKind('gflops')}
                            aria-label="Phóng to biểu đồ GFLOPS"
                            className="h-7 w-7 rounded border border-[var(--border)] inline-flex items-center justify-center hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                          >
                            <Maximize2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <EChartPanel
                        ref={splitLeftRef}
                        kind="gflops"
                        records={records}
                        hiddenAlgos={hiddenAlgos}
                        useLogScale={logScaleByKind.gflops}
                        threadN={threadN}
                        theme={theme}
                        plan={plan}
                        activeStep={activeStep}
                        isRunning={isRunning}
                        height="clamp(420px, 56vh, 620px)"
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <h2 className="text-sm font-bold">
                            Thời gian thực thi (ms)
                            {isRunning && activeStep?.n ? ` · N = ${activeStep.n}` : ''}
                          </h2>
                          <p className="text-xs text-[var(--muted)]">
                            Cột hiện lên nhanh ngay khi từng thuật toán xong · Thấp hơn tốt hơn
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => splitRightRef.current?.downloadPng('matmul_time.png')}
                            className="h-7 px-2 rounded border border-[var(--border)] text-xs font-semibold hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                          >
                            PNG
                          </button>
                          <button
                            type="button"
                            onClick={() => setFullscreenKind('time')}
                            aria-label="Phóng to biểu đồ Thời gian"
                            className="h-7 w-7 rounded border border-[var(--border)] inline-flex items-center justify-center hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                          >
                            <Maximize2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <EChartPanel
                        ref={splitRightRef}
                        kind="time"
                        records={records}
                        hiddenAlgos={hiddenAlgos}
                        useLogScale={logScaleByKind.time}
                        threadN={threadN}
                        theme={theme}
                        plan={plan}
                        activeStep={activeStep}
                        isRunning={isRunning}
                        height="clamp(420px, 56vh, 620px)"
                      />
                    </div>
                  </div>
                )}

                {/* SINGLE FULL-WIDTH CHART */}
                {(metric === 'gflops' || metric === 'time' || metric === 'speedup' || metric === 'threads') && (
                  <EChartPanel
                    ref={mainChartRef}
                    kind={metric}
                    records={records}
                    hiddenAlgos={hiddenAlgos}
                    useLogScale={metric === 'threads' ? false : logScaleByKind[metric]}
                    threadN={threadN}
                    theme={theme}
                    plan={plan}
                    activeStep={activeStep}
                    isRunning={isRunning}
                    height="clamp(460px, 60vh, 680px)"
                    forceBar={forceBar}
                  />
                )}

                {/* 2x2 FULL-WIDTH ANALYTICAL GRID */}
                {metric === 'grid' && (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {(
                      [
                        ['gflops', '1. Hiệu năng tính toán (GFLOPS)'],
                        ['time', '2. Thời gian thực thi (ms)'],
                        ['speedup', '3. Hệ số tăng tốc (Speedup)'],
                        ['threads', `4. Mở rộng luồng CPU (N = ${threadN ?? '—'})`],
                      ] as [ChartKind, string][]
                    ).map(([k, title]) => (
                      <div key={k} className="rounded-md border border-[var(--border-soft)] p-3.5 space-y-1">
                        <div className="flex items-center justify-between">
                          <h2 className="text-sm font-bold">{title}</h2>
                          <button
                            type="button"
                            onClick={() => setFullscreenKind(k)}
                            className="h-7 px-2 rounded border border-[var(--border)] text-xs font-semibold inline-flex items-center gap-1 hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                          >
                            <Maximize2 className="w-3 h-3" />
                            Soi lớn
                          </button>
                        </div>
                        <EChartPanel
                          kind={k}
                          records={records}
                          hiddenAlgos={hiddenAlgos}
                          useLogScale={k === 'threads' ? false : logScaleByKind[k]}
                          threadN={threadN}
                          theme={theme}
                          plan={plan}
                          activeStep={activeStep}
                          isRunning={isRunning}
                          height="310px"
                          compact
                        />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {mainTab === 'hybrid' && <HybridPanel hybrid={hybrid} />}
            {mainTab === 'table' && <TablesPanel records={records} />}
          </div>
        </section>
      </main>

      {/* 6. FULLSCREEN CHART INSPECT MODAL (96vw x 90vh, DataZoom enabled, ESC / F) */}
      {fullscreenKind && (
        <div
          className="anim-fade fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-5"
          role="dialog"
          aria-modal="true"
          aria-label="Chế độ phóng to biểu đồ"
          onClick={(e) => {
            if (e.target === e.currentTarget) setFullscreenKind(null);
          }}
        >
          <div className="anim-modal w-full h-full max-w-[1840px] max-h-[94vh] rounded-lg border border-[var(--border)] bg-[var(--surface)] flex flex-col overflow-hidden shadow-2xl">
            <div className="px-5 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold mr-2">Chế độ soi biểu đồ</span>
                <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--subtle)] p-0.5">
                  {(
                    [
                      ['gflops', 'GFLOPS'],
                      ['time', 'Thời gian (ms)'],
                      ['speedup', 'Speedup'],
                      ['threads', 'Luồng CPU'],
                    ] as [ChartKind, string][]
                  ).map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setFullscreenKind(k)}
                      className={`px-3 py-1 text-xs font-semibold rounded cursor-pointer ${
                        fullscreenKind === k
                          ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs'
                          : 'text-[var(--muted)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>

                {fullscreenKind !== 'threads' && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        setLogScaleByKind((prev) => ({
                          ...prev,
                          [fullscreenKind]: !prev[fullscreenKind],
                        }))
                      }
                      className={`h-8 px-2.5 rounded-md border text-xs font-semibold cursor-pointer ${
                        logScaleByKind[fullscreenKind]
                          ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--subtle)]'
                          : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--ink)] bg-transparent'
                      }`}
                    >
                      {logScaleByKind[fullscreenKind] ? 'Thang Log10' : 'Thang Linear'}
                    </button>
                    {uniqueMeasuredN.length >= 2 && (
                      <button
                        type="button"
                        onClick={() => setForceBar((b) => !b)}
                        className="h-8 px-2.5 rounded-md border border-[var(--border)] text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] bg-transparent cursor-pointer"
                      >
                        {forceBar ? 'Dạng Đường' : 'Dạng Thanh'}
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fsChartRef.current?.resetZoom()}
                  className="h-8 px-2.5 rounded-md border border-[var(--border)] text-xs font-semibold inline-flex items-center gap-1 hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Đặt lại Zoom
                </button>
                <button
                  type="button"
                  onClick={() => fsChartRef.current?.downloadPng(`matmul_${fullscreenKind}_hd.png`)}
                  className="h-8 px-2.5 rounded-md border border-[var(--border)] text-xs font-semibold inline-flex items-center gap-1 hover:bg-[var(--subtle)] cursor-pointer bg-transparent"
                >
                  <Download className="w-3.5 h-3.5" />
                  Tải PNG HD
                </button>
                <button
                  type="button"
                  onClick={() => setFullscreenKind(null)}
                  className="h-8 px-3 rounded-md bg-[var(--ink)] text-[var(--bg)] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer border-0"
                >
                  <Minimize2 className="w-3.5 h-3.5" />
                  Đóng (Esc)
                </button>
              </div>
            </div>

            <div className="flex-1 p-5 min-h-0">
              <EChartPanel
                ref={fsChartRef}
                kind={fullscreenKind}
                records={records}
                hiddenAlgos={hiddenAlgos}
                useLogScale={fullscreenKind === 'threads' ? false : logScaleByKind[fullscreenKind]}
                threadN={threadN}
                theme={theme}
                plan={plan}
                activeStep={activeStep}
                isRunning={isRunning}
                height="100%"
                enableZoom
                forceBar={forceBar}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
