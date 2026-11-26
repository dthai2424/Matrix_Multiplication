import { useEffect, useState } from 'react';
import { RotateCcw, FlaskConical, CheckCircle2 } from 'lucide-react';
import type { HybridState } from '../types';

interface HybridPanelProps {
  hybrid: HybridState;
}

export function HybridPanel({ hybrid }: HybridPanelProps) {
  const optimalPct = Math.round((hybrid.alpha_star || hybrid.alpha0 || 0.875) * 100);
  const [sliderPct, setSliderPct] = useState(optimalPct);

  useEffect(() => {
    setSliderPct(Math.round((hybrid.alpha_star || hybrid.alpha0 || 0.875) * 100));
  }, [hybrid.alpha_star, hybrid.alpha0]);

  const isSimulating = Math.abs(sliderPct - optimalPct) >= 1;

  // Aligned to 64 rows on N=2048 (matching src/algorithms.cpp kTuneSize=2048, kAlignStep=64)
  const N = 2048;
  const alpha = sliderPct / 100;
  const mGpu = Math.max(64, Math.min(N - 64, Math.floor((alpha * N) / 64) * 64));
  const mCpu = N - mGpu;
  const effAlpha = mGpu / N;
  const gpuPct = effAlpha * 100;
  const cpuPct = (1 - effAlpha) * 100;

  const pCpu = hybrid.perf_cpu || 15.1;
  const pGpu = hybrid.perf_gpu || 103.1;
  const flops = 2.0 * N * N * N;
  const simTGpu = (flops * effAlpha) / (pGpu * 1e9);
  const simTCpu = (flops * (1 - effAlpha)) / (pCpu * 1e9);
  const simMax = Math.max(simTGpu, simTCpu);
  const simImb = simMax / (0.5 * (simTGpu + simTCpu));

  // Shared max time scale across all real rounds + interactive what-if bar
  const allTimes = [
    ...hybrid.iterations.flatMap((it) => [it.t_gpu, it.t_cpu]),
    simTGpu,
    simTCpu,
  ];
  const maxTimeScale = Math.max(...allTimes, 0.05) * 1.08;

  const a0Pct = (hybrid.alpha0 ?? hybrid.alpha_star) * 100;
  const aStarPct = hybrid.alpha_star * 100;

  return (
    <div className="space-y-6 tabular">
      {/* Compact 3-Step Summary Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] pb-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight">
            Cân bằng tải dị thể CPU + GPU (α*)
          </h2>
          <p className="text-sm text-[var(--muted)] mt-0.5">
            Bước 1 chấm điểm thực lực tại N={hybrid.calib_n} → Bước 2 ước lượng α₀ ={' '}
            <strong className="text-[var(--ink)]">{a0Pct.toFixed(1)}%</strong> → Bước 3 tinh chỉnh hội tụ tại{' '}
            <strong className="text-[var(--accent)]">α* = {aStarPct.toFixed(1)}%</strong> (Imbalance{' '}
            {hybrid.imbalance.toFixed(3)}).
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isSimulating ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold border border-dashed border-[var(--accent)] hatch-sim text-[var(--accent)]">
              <FlaskConical className="w-3.5 h-3.5" />
              Mô phỏng lý thuyết (What-if)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-semibold border border-[var(--ok)] text-[var(--ok)]">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {hybrid.from_cache ? 'α* thực đo (từ hybrid_alpha.cfg)' : 'Đo thực tế từ C++/CUDA'}
            </span>
          )}
        </div>
      </div>

      {/* LAYER 1: Unified Proportional Split Bar with Endpoint Scores + Anchor Ticks + Slider */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-[var(--muted)]">Điểm GPU (N={hybrid.calib_n})</div>
            <div className="text-2xl font-bold text-[#059669]">
              {hybrid.perf_gpu ? `${hybrid.perf_gpu.toFixed(1)} GFLOPS` : 'Từ cache'}
            </div>
            <div className="text-xs text-[var(--muted)]">
              GPU nhận <strong>{mGpu}</strong> hàng ({gpuPct.toFixed(1)}%)
            </div>
          </div>

          <div className="text-center">
            <div className="text-xs font-medium text-[var(--muted)]">Tỷ lệ đang xem (căn bội 64)</div>
            <div className="text-xl font-bold text-[var(--ink)]">
              GPU {gpuPct.toFixed(1)}% / CPU {cpuPct.toFixed(1)}%
            </div>
          </div>

          <div className="text-right">
            <div className="text-xs font-medium text-[var(--muted)]">Điểm CPU (N={hybrid.calib_n})</div>
            <div className="text-2xl font-bold text-[#2563eb]">
              {hybrid.perf_cpu ? `${hybrid.perf_cpu.toFixed(1)} GFLOPS` : 'Từ cache'}
            </div>
            <div className="text-xs text-[var(--muted)]">
              CPU nhận <strong>{mCpu}</strong> hàng ({cpuPct.toFixed(1)}%)
            </div>
          </div>
        </div>

        {/* Visual Split Bar + Anchors */}
        <div className="relative pt-5 pb-1">
          {/* Reference anchor marker for alpha* */}
          <div
            className="absolute top-0 -translate-x-1/2 text-xs font-semibold text-[var(--accent)] whitespace-nowrap"
            style={{ left: `${aStarPct}%` }}
          >
            α* {aStarPct.toFixed(1)}% ▼
          </div>
          <div className="flex h-10 rounded overflow-hidden border border-[var(--border)] text-sm font-semibold">
            <div
              className="bg-[#059669] text-white flex items-center justify-center px-2 whitespace-nowrap overflow-hidden"
              style={{ width: `${gpuPct}%` }}
            >
              {gpuPct >= 16 ? `GPU · ${mGpu} hàng` : ''}
            </div>
            <div
              className="bg-[#2563eb] text-white flex items-center justify-center px-2 whitespace-nowrap overflow-hidden"
              style={{ width: `${cpuPct}%` }}
            >
              {cpuPct >= 16 ? `CPU · ${mCpu} hàng` : ''}
            </div>
          </div>
        </div>

        {/* Direct What-If Slider */}
        <div className="pt-1 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <label htmlFor="hybridAlphaSlider" className="font-semibold text-[var(--muted)]">
              Kéo thử tỷ lệ α (5%–97%) để xem vùng chờ chết (Idle Wait) phình to khi chia lệch tải
            </label>
            {isSimulating && (
              <button
                type="button"
                onClick={() => setSliderPct(optimalPct)}
                className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent)] hover:underline cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Về α* thực đo ({optimalPct}%)
              </button>
            )}
          </div>
          <input
            id="hybridAlphaSlider"
            type="range"
            min={5}
            max={97}
            step={1}
            value={sliderPct}
            onChange={(e) => setSliderPct(Number(e.target.value))}
            className="w-full accent-[var(--accent)] cursor-pointer"
          />
        </div>
      </div>

      {/* LAYER 2: Paired Horizontal Time-Balance Bars (t_GPU vs t_CPU + Hatched Idle Wait) */}
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">
            Thời gian chạy song song t_GPU vs t_CPU &amp; Vùng chờ chết (Idle Wait)
          </h3>
          <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-xs bg-[#059669]" /> GPU
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-xs bg-[#2563eb]" /> CPU
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-xs border border-amber-600 hatch-wait" /> Chờ chết |t_GPU − t_CPU|
            </span>
          </div>
        </div>

        <div className="space-y-4">
          {/* Measured Calibration Rounds (Solid bars) */}
          {hybrid.iterations.map((it) => {
            const tMax = Math.max(it.t_gpu, it.t_cpu);
            const gpuW = (it.t_gpu / maxTimeScale) * 100;
            const cpuW = (it.t_cpu / maxTimeScale) * 100;
            const waitW = (Math.abs(it.t_gpu - it.t_cpu) / maxTimeScale) * 100;
            const gpuWaits = it.t_gpu < it.t_cpu;

            return (
              <div key={it.round} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold">
                    Vòng {it.round} (Đo thực tế · M_GPU={it.m_gpu}, M_CPU={it.m_cpu})
                  </span>
                  <span className="font-mono">
                    Tổng T = <strong>{(tMax * 1000).toFixed(1)} ms</strong> · Imbalance ={' '}
                    <strong className={it.imbalance <= 1.05 ? 'text-[var(--ok)]' : 'text-[var(--warn)]'}>
                      {it.imbalance.toFixed(3)}
                    </strong>
                  </span>
                </div>

                {/* GPU Row */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-10 font-semibold text-[var(--muted)]">GPU</span>
                  <div className="flex-1 h-5 bg-[var(--subtle)] rounded-xs overflow-hidden flex items-center">
                    <div className="h-full bg-[#059669]" style={{ width: `${gpuW}%` }} />
                    {gpuWaits && waitW > 0.5 && (
                      <div
                        className="h-full hatch-wait border-y border-r border-amber-600/60"
                        style={{ width: `${waitW}%` }}
                        title="GPU xong sớm, phải chờ CPU"
                      />
                    )}
                    <span className="ml-2 font-mono text-[var(--ink)]">{(it.t_gpu * 1000).toFixed(1)} ms</span>
                  </div>
                </div>

                {/* CPU Row */}
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-10 font-semibold text-[var(--muted)]">CPU</span>
                  <div className="flex-1 h-5 bg-[var(--subtle)] rounded-xs overflow-hidden flex items-center">
                    <div className="h-full bg-[#2563eb]" style={{ width: `${cpuW}%` }} />
                    {!gpuWaits && waitW > 0.5 && (
                      <div
                        className="h-full hatch-wait border-y border-r border-amber-600/60"
                        style={{ width: `${waitW}%` }}
                        title="CPU xong sớm, phải chờ GPU"
                      />
                    )}
                    <span className="ml-2 font-mono text-[var(--ink)]">{(it.t_cpu * 1000).toFixed(1)} ms</span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Interactive What-If Row (Shown prominently when user drags slider away from alpha*) */}
          {isSimulating && (
            <div className="pt-3 border-t border-dashed border-[var(--border)] space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[var(--accent)]">
                  Mô phỏng lý thuyết tại α = {gpuPct.toFixed(1)}% (M_GPU={mGpu}, M_CPU={mCpu})
                </span>
                <span className="font-mono">
                  Ước tính max(t) = <strong>{(simMax * 1000).toFixed(1)} ms</strong> · Imbalance ={' '}
                  <strong className={simImb <= 1.08 ? 'text-[var(--ok)]' : 'text-[var(--danger)]'}>
                    {simImb.toFixed(3)}
                  </strong>
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="w-10 font-semibold text-[var(--muted)]">GPU</span>
                <div className="flex-1 h-5 bg-[var(--subtle)] rounded-xs overflow-hidden flex items-center">
                  <div
                    className="h-full border border-dashed border-[#059669] bg-[#059669]/35"
                    style={{ width: `${(simTGpu / maxTimeScale) * 100}%` }}
                  />
                  {simTGpu < simTCpu && (
                    <div
                      className="h-full hatch-wait border-y border-r border-amber-600/70"
                      style={{ width: `${((simTCpu - simTGpu) / maxTimeScale) * 100}%` }}
                    />
                  )}
                  <span className="ml-2 font-mono">{(simTGpu * 1000).toFixed(1)} ms</span>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="w-10 font-semibold text-[var(--muted)]">CPU</span>
                <div className="flex-1 h-5 bg-[var(--subtle)] rounded-xs overflow-hidden flex items-center">
                  <div
                    className="h-full border border-dashed border-[#2563eb] bg-[#2563eb]/35"
                    style={{ width: `${(simTCpu / maxTimeScale) * 100}%` }}
                  />
                  {simTCpu < simTGpu && (
                    <div
                      className="h-full hatch-wait border-y border-r border-amber-600/70"
                      style={{ width: `${((simTGpu - simTCpu) / maxTimeScale) * 100}%` }}
                    />
                  )}
                  <span className="ml-2 font-mono">{(simTCpu * 1000).toFixed(1)} ms</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
