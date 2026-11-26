import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, EffectScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { UniversalTransition } from 'echarts/features';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { ALGO_META, ALGO_ORDER } from '../data';
import type { ActiveStep, AlgoKey, BenchmarkRecord, ExecutionPlan } from '../types';

echarts.use([
  BarChart,
  LineChart,
  EffectScatterChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  DataZoomComponent,
  MarkLineComponent,
  CanvasRenderer,
  UniversalTransition,
]);

export type ChartKind = 'gflops' | 'time' | 'speedup' | 'threads';

export interface EChartPanelHandle {
  downloadPng: (filename: string) => void;
  resetZoom: () => void;
  resize: () => void;
}

interface EChartPanelProps {
  kind: ChartKind;
  records: BenchmarkRecord[];
  hiddenAlgos: Set<AlgoKey>;
  useLogScale: boolean;
  threadN: number | null;
  theme: 'light' | 'dark';
  plan: ExecutionPlan | null;
  activeStep: ActiveStep | null;
  isRunning: boolean;
  height?: string;
  enableZoom?: boolean;
  compact?: boolean;
  forceBar?: boolean;
}

function getBest(data: BenchmarkRecord[], n: number, key: AlgoKey): BenchmarkRecord | null {
  const list = data.filter((d) => d.n === n && d.key === key);
  if (!list.length) return null;
  return list.reduce((a, b) => (b.gflops > a.gflops ? b : a));
}

function fmtAxisTick(val: number, kind: ChartKind): string {
  if (val === 0) return '0';
  if (kind === 'time') {
    if (val >= 10) return `${val.toFixed(0)}s`;
    if (val >= 1) return `${val.toFixed(1)}s`;
    if (val >= 0.01) return `${(val * 1000).toFixed(0)}ms`;
    return `${(val * 1000).toFixed(1)}ms`;
  }
  if (kind === 'speedup') {
    return val >= 10 ? `${val.toFixed(0)}×` : `${val.toFixed(1)}×`;
  }
  return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : `${Number(val.toPrecision(3))}`;
}

export const EChartPanel = forwardRef<EChartPanelHandle, EChartPanelProps>(function EChartPanel(
  {
    kind,
    records,
    hiddenAlgos,
    useLogScale,
    threadN,
    theme,
    plan,
    activeStep,
    isRunning,
    height = '440px',
    enableZoom = false,
    compact = false,
    forceBar = false,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const liveElapsedRef = useRef<number>(0);

  useImperativeHandle(ref, () => ({
    downloadPng(filename: string) {
      if (!chartRef.current) return;
      const bg = theme === 'dark' ? '#111114' : '#ffffff';
      const url = chartRef.current.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: bg,
      });
      const a = document.createElement('a');
      a.download = filename;
      a.href = url;
      a.click();
    },
    resetZoom() {
      chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    },
    resize() {
      chartRef.current?.resize();
    },
  }));

  // Init ECharts + ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const inst = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = inst;

    const ro = new ResizeObserver(() => {
      inst.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  // Helper to build option with optional live elapsed seconds for growing active bar
  const buildOption = (liveElapsedSec: number | null): EChartsCoreOption => {
    const isDark = theme === 'dark';
    const ink = isDark ? '#f8fafc' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#475569';
    const gridColor = isDark ? '#23232a' : '#e2e8f0';
    const tooltipBg = isDark ? '#18181c' : '#ffffff';
    const tooltipBorder = isDark ? '#3f3f46' : '#cbd5e1';
    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const visible = records.filter((r) => !hiddenAlgos.has(r.key));
    const measuredNs = [...new Set(visible.map((r) => r.n))].sort((a, b) => a - b);
    // Lock X-axis to plan.sizes while running so chart never jumps sideways
    const allNs =
      isRunning && plan?.sizes?.length
        ? [...new Set([...plan.sizes, ...measuredNs])].sort((a, b) => a - b)
        : measuredNs;

    const presentKeys = ALGO_ORDER.filter(
      (k) =>
        !hiddenAlgos.has(k) &&
        (visible.some((r) => r.key === k) ||
          (isRunning && activeStep?.key === k))
    );

    const fontSize = compact ? 12 : 13.5;

    // -------------------------------------------------------------------------
    // MODE A: THREAD SCALING (Line + Dot + Ideal Linear Scaling Reference)
    // -------------------------------------------------------------------------
    if (kind === 'threads') {
      const targetN = threadN ?? measuredNs[measuredNs.length - 1] ?? 1024;
      const scaleKeys = (['omp_basic', 'omp_l2_l3', 'omp_bypass', 'hybrid'] as AlgoKey[]).filter(
        (k) => !hiddenAlgos.has(k) && visible.some((r) => r.n === targetN && r.key === k)
      );
      const threads = [
        ...new Set(
          visible
            .filter((r) => r.n === targetN && scaleKeys.includes(r.key))
            .map((r) => r.threads)
        ),
      ].sort((a, b) => a - b);

      if (!threads.length) {
        return {
          title: {
            text: `Chưa có dữ liệu đa luồng CPU tại N = ${targetN}`,
            left: 'center',
            top: 'middle',
            textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
          },
          xAxis: { show: false },
          yAxis: { show: false },
          series: [],
        };
      }

      const series: any[] = scaleKeys.map((k) => {
        const m = ALGO_META[k];
        return {
          name: m.name,
          type: 'line',
          smooth: false,
          symbol: m.symbol,
          symbolSize: compact ? 7 : 9,
          lineStyle: { color: m.color, width: m.lineWidth, type: m.lineStyle },
          itemStyle: { color: m.color },
          emphasis: { focus: 'series' },
          data: threads.map((t) => {
            const matches = visible.filter((r) => r.n === targetN && r.key === k && r.threads === t);
            if (!matches.length) return null;
            const best = matches.reduce((a, b) => (b.gflops > a.gflops ? b : a));
            return { value: Number(best.gflops.toFixed(2)), raw: best };
          }),
        };
      });

      // Add Ideal Linear Scaling dashed reference line from 1T baseline (if 1T exists)
      const base1T = visible.find(
        (r) => r.n === targetN && (r.key === 'seq' || (r.key === 'omp_basic' && r.threads === 1))
      );
      if (base1T && threads.length >= 2) {
        series.push({
          name: 'Tuyến tính lý tưởng (P₁ × T)',
          type: 'line',
          symbol: 'none',
          silent: true,
          lineStyle: { color: muted, width: 1.5, type: 'dashed', opacity: 0.6 },
          data: threads.map((t) => Number((base1T.gflops * t).toFixed(2))),
        });
      }

      return {
        animation: !reducedMotion,
        animationDuration: 360,
        animationDurationUpdate: 220,
        animationEasing: 'cubicOut',
        grid: {
          top: compact ? 22 : 28,
          right: compact ? 24 : 36,
          bottom: enableZoom ? 54 : 36,
          left: 16,
          containLabel: true,
        },
        tooltip: {
          trigger: 'axis',
          backgroundColor: tooltipBg,
          borderColor: tooltipBorder,
          textStyle: { color: ink, fontSize: 13 },
          axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
          formatter: (params: any) => {
            const items = (Array.isArray(params) ? params : [params])
              .filter((p) => p.value != null)
              .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
            if (!items.length) return '';
            const head = `<div style="font-weight:700;margin-bottom:6px">N = ${targetN} · ${items[0].axisValue}</div>`;
            const rows = items
              .map(
                (p) =>
                  `<div style="display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums">
                    <span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>
                    <strong>${Number(p.value).toFixed(2)} GFLOPS</strong>
                  </div>`
              )
              .join('');
            return head + rows;
          },
        },
        xAxis: {
          type: 'category',
          data: threads.map((t) => `${t}T`),
          axisLabel: { color: ink, fontSize, fontWeight: 600 },
          axisLine: { lineStyle: { color: gridColor } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value',
          name: 'GFLOPS',
          nameTextStyle: { color: muted, fontSize: 12.5, padding: [0, 0, 4, 0] },
          axisLabel: { color: muted, fontSize, formatter: (v: number) => fmtAxisTick(v, 'gflops') },
          splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
        },
        dataZoom: enableZoom ? [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 6 }] : [],
        series,
      };
    }

    // -------------------------------------------------------------------------
    // MODE B: HORIZONTAL BAR (Live Running View for active N, OR when 1 N, OR forced)
    // Shows live-growing active Time bar in real time!
    // -------------------------------------------------------------------------
    const isSingleN = allNs.length <= 1;
    const showLiveGrowingBar =
      (kind === 'time' && isRunning && activeStep?.phase === 'compute') ||
      isSingleN ||
      forceBar;

    if (showLiveGrowingBar) {
      const targetN =
        (isRunning && activeStep?.n) ||
        allNs[allNs.length - 1] ||
        plan?.sizes?.[0] ||
        512;

      const algoKeys = ALGO_ORDER.filter(
        (k) =>
          !hiddenAlgos.has(k) &&
          !(k === 'seq' && targetN >= 2048) &&
          !(plan?.gpu_only && ALGO_META[k].group === 'cpu')
      );

      interface BarRow {
        key: AlgoKey;
        name: string;
        value: number | null;
        isActiveNow: boolean;
        rec: BenchmarkRecord | null;
      }

      const rows: BarRow[] = algoKeys.map((k) => {
        const rec = getBest(visible, targetN, k);
        const isActiveNow =
          isRunning &&
          activeStep?.phase === 'compute' &&
          activeStep.n === targetN &&
          activeStep.key === k;

        let val: number | null = null;
        if (kind === 'time' && isActiveNow && liveElapsedSec != null) {
          val = Math.max(0.001, liveElapsedSec);
        } else if (rec) {
          val = kind === 'gflops' ? rec.gflops : kind === 'time' ? rec.time : rec.speedup;
        }
        return { key: k, name: ALGO_META[k].name, value: val, isActiveNow, rec };
      });

      // Sort cleanly when not actively growing (or keep consistent order during live run so bars don't jump rows!)
      if (!isRunning) {
        rows.sort((a, b) => {
          const av = a.value ?? -1;
          const bv = b.value ?? -1;
          return kind === 'time' ? bv - av : av - bv;
        });
      } else {
        rows.reverse(); // Top-to-bottom natural order (1. Baseline -> 7. CUDA Shared)
      }

      const hasAnyValue = rows.some((r) => r.value != null && r.value > 0);
      if (!hasAnyValue) {
        return {
          title: {
            text: isRunning
              ? `Đang đo N = ${targetN}... thanh sẽ tự mọc ngay khi kernel chạy`
              : 'Chưa có dữ liệu — bấm Chạy thực nghiệm để bắt đầu',
            left: 'center',
            top: 'middle',
            textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
          },
          xAxis: { show: false },
          yAxis: { show: false },
          series: [],
        };
      }

      const logAxis = useLogScale;
      const unitLabel =
        kind === 'gflops' ? 'GFLOPS' : kind === 'time' ? 'Thời gian (s)' : 'Speedup (×)';

      return {
        animation: !reducedMotion && !(isRunning && kind === 'time' && liveElapsedSec != null),
        animationDuration: 340,
        animationDurationUpdate: isRunning && kind === 'time' ? 0 : 240,
        animationEasing: 'cubicOut',
        grid: {
          top: compact ? 18 : 26,
          right: compact ? 76 : 112,
          bottom: enableZoom ? 54 : 34,
          left: 14,
          containLabel: true,
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: tooltipBg,
          borderColor: tooltipBorder,
          textStyle: { color: ink, fontSize: 13 },
          formatter: (params: any) => {
            const p = Array.isArray(params) ? params[0] : params;
            const row = rows[p.dataIndex];
            if (!row) return '';
            if (row.isActiveNow && kind === 'time') {
              return `<strong>${row.name}</strong> (N = ${targetN})<br/><span style="color:${ALGO_META[row.key].color}">● Đang thực thi: <strong>${(row.value ?? 0).toFixed(2)}s</strong></span>`;
            }
            if (!row.rec) return `<strong>${row.name}</strong><br/><span style="color:${muted}">Đang chờ thực thi...</span>`;
            const tag = ALGO_META[row.key].group === 'gpu' ? 'GPU CUDA' : `${row.rec.threads}T`;
            return `<div style="font-variant-numeric:tabular-nums">
              <strong>${row.name}</strong> · N = ${targetN} (${tag})<br/>
              Hiệu năng: <strong>${row.rec.gflops.toFixed(2)} GFLOPS</strong><br/>
              Thời gian: <strong>${row.rec.time.toFixed(4)}s</strong><br/>
              Speedup: <strong>${row.rec.speedup.toFixed(2)}×</strong>
            </div>`;
          },
        },
        xAxis: {
          type: logAxis ? 'log' : 'value',
          logBase: 10,
          min: logAxis ? undefined : 0,
          name: unitLabel,
          nameLocation: 'end',
          nameTextStyle: { color: muted, fontSize: 12 },
          axisLabel: {
            color: muted,
            fontSize,
            formatter: (v: number) => fmtAxisTick(v, kind),
          },
          splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
        },
        yAxis: {
          type: 'category',
          data: rows.map((r) => (compact ? ALGO_META[r.key].shortName : r.name)),
          axisLabel: { color: ink, fontSize, fontWeight: 600 },
          axisLine: { lineStyle: { color: gridColor } },
          axisTick: { show: false },
        },
        series: [
          {
            type: 'bar',
            barMaxWidth: compact ? 22 : 30,
            universalTransition: !isRunning,
            data: rows.map((r) => {
              const color = ALGO_META[r.key].color;
              if (r.isActiveNow && kind === 'time') {
                return {
                  value: r.value,
                  itemStyle: {
                    color: `${color}55`,
                    borderColor: color,
                    borderWidth: 2,
                    borderType: 'dashed',
                    borderRadius: [0, 4, 4, 0],
                  },
                  label: {
                    show: true,
                    position: 'right',
                    formatter: `● ${(r.value ?? 0).toFixed(2)}s`,
                    color,
                    fontWeight: 700,
                    fontSize,
                  },
                };
              }
              return {
                value: r.value,
                itemStyle: {
                  color,
                  borderRadius: [0, 4, 4, 0],
                },
                label: {
                  show: r.value != null,
                  position: 'right',
                  formatter: () => {
                    if (r.value == null) return '';
                    if (kind === 'time') return `${r.value >= 1 ? r.value.toFixed(2) + 's' : (r.value * 1000).toFixed(1) + 'ms'}`;
                    if (kind === 'speedup') return `${r.value.toFixed(1)}×`;
                    return `${r.value.toFixed(1)} G`;
                  },
                  color: ink,
                  fontWeight: 600,
                  fontSize,
                },
              };
            }),
          },
        ],
      };
    }

    // -------------------------------------------------------------------------
    // MODE C: MULTI-N LINE + DOT CHART (Clean Scaling Curves across N=512..4096)
    // -------------------------------------------------------------------------
    if (!allNs.length || !presentKeys.length) {
      return {
        title: {
          text: 'Chưa có dữ liệu — bấm Chạy thực nghiệm để vẽ biểu đồ',
          left: 'center',
          top: 'middle',
          textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
        },
        xAxis: { show: false },
        yAxis: { show: false },
        series: [],
      };
    }

    const logAxis = useLogScale;
    const unitLabel =
      kind === 'gflops' ? 'GFLOPS' : kind === 'time' ? 'Thời gian (s)' : 'Speedup (×)';

    // Smart end-of-line direct labels: avoid overlaps on Linear scale by labeling top GPU, Hybrid, and top CPU
    const lastN = measuredNs[measuredNs.length - 1];
    const lastVals = presentKeys
      .map((k) => {
        const r = lastN ? getBest(visible, lastN, k) : null;
        const v = r ? (kind === 'gflops' ? r.gflops : kind === 'time' ? r.time : r.speedup) : null;
        return { k, v };
      })
      .filter((x) => x.v != null) as { k: AlgoKey; v: number }[];

    const labeledSet = new Set<AlgoKey>();
    if (!compact) {
      if (logAxis) {
        lastVals.forEach((x) => labeledSet.add(x.k));
      } else if (lastVals.length) {
        // Pick hero per semantic group so labels never collide at bottom
        for (const grp of ['gpu', 'hybrid', 'cpu'] as const) {
          const grpItems = lastVals.filter((x) => ALGO_META[x.k].group === grp);
          if (grpItems.length) {
            const pick = grpItems.reduce((a, b) => (b.v > a.v ? b : a));
            labeledSet.add(pick.k);
          }
        }
      }
    }

    const series: any[] = presentKeys.map((k) => {
      const m = ALGO_META[k];
      return {
        name: m.name,
        type: 'line',
        smooth: false,
        connectNulls: false,
        symbol: m.symbol,
        symbolSize: compact ? 7 : 9,
        lineStyle: { color: m.color, width: m.lineWidth, type: m.lineStyle },
        itemStyle: { color: m.color },
        emphasis: { focus: 'series' },
        endLabel: {
          show: labeledSet.has(k),
          distance: 8,
          formatter: (p: any) => {
            const v = Number(p.value);
            const valTxt =
              kind === 'time'
                ? v >= 1
                  ? `${v.toFixed(2)}s`
                  : `${(v * 1000).toFixed(1)}ms`
                : kind === 'speedup'
                ? `${v.toFixed(1)}×`
                : `${v.toFixed(0)}G`;
            return `${m.shortName} (${valTxt})`;
          },
          color: m.color,
          fontSize: 12.5,
          fontWeight: 600,
        },
        labelLayout: { moveOverlap: 'shiftY' },
        data: allNs.map((n) => {
          const rec = getBest(visible, n, k);
          if (!rec) return null;
          const v = kind === 'gflops' ? rec.gflops : kind === 'time' ? rec.time : rec.speedup;
          return { value: Number(v.toFixed(kind === 'time' ? 5 : 2)), raw: rec };
        }),
      };
    });

    // Subtle pulsing ripple on currently executing point (if running and we have a reference Y)
    if (isRunning && activeStep && activeStep.phase === 'compute' && activeStep.key !== 'ref') {
      const aKey = activeStep.key as AlgoKey;
      const prevRec = visible.filter((r) => r.key === aKey).slice(-1)[0];
      const approxY = prevRec
        ? kind === 'gflops'
          ? prevRec.gflops
          : kind === 'time'
          ? prevRec.time
          : prevRec.speedup
        : null;
      const xIdx = allNs.indexOf(activeStep.n);
      if (xIdx >= 0 && approxY != null && approxY > 0) {
        series.push({
          name: 'Đang đo',
          type: 'effectScatter',
          silent: true,
          rippleEffect: { brushType: 'stroke', scale: 3.4, period: 2.2 },
          symbolSize: 10,
          itemStyle: { color: ALGO_META[aKey].color },
          data: [[`N=${activeStep.n}`, approxY]],
        });
      }
    }

    return {
      animation: !reducedMotion,
      animationDuration: 360,
      animationDurationUpdate: 220,
      animationEasing: 'cubicOut',
      grid: {
        top: compact ? 22 : 28,
        right: compact ? 26 : 148,
        bottom: enableZoom ? 56 : 36,
        left: 16,
        containLabel: true,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: tooltipBg,
        borderColor: tooltipBorder,
        textStyle: { color: ink, fontSize: 13 },
        axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
        formatter: (params: any) => {
          const items = (Array.isArray(params) ? params : [params])
            .filter((p) => p.value != null && p.seriesType === 'line')
            .sort((a, b) => (kind === 'time' ? a.value - b.value : b.value - a.value));
          if (!items.length) return '';
          const head = `<div style="font-weight:700;margin-bottom:6px">${items[0].axisValue} — Xếp hạng ${unitLabel}</div>`;
          const rows = items
            .map((p) => {
              const v = Number(p.value);
              const txt =
                kind === 'time'
                  ? v >= 1
                    ? `${v.toFixed(3)}s`
                    : `${(v * 1000).toFixed(2)}ms`
                  : kind === 'speedup'
                  ? `${v.toFixed(2)}×`
                  : `${v.toFixed(2)} GFLOPS`;
              return `<div style="display:flex;justify-content:space-between;gap:18px;font-variant-numeric:tabular-nums;margin:2px 0">
                <span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>
                <strong>${txt}</strong>
              </div>`;
            })
            .join('');
          return head + rows;
        },
      },
      xAxis: {
        type: 'category',
        boundaryGap: true,
        data: allNs.map((n) => `N=${n}`),
        axisLabel: { color: ink, fontSize, fontWeight: 600 },
        axisLine: { lineStyle: { color: gridColor } },
        axisTick: { show: false },
      },
      yAxis: {
        type: logAxis ? 'log' : 'value',
        logBase: 10,
        min: logAxis ? undefined : 0,
        name: unitLabel,
        nameTextStyle: { color: muted, fontSize: 12.5, padding: [0, 0, 4, 0] },
        axisLabel: {
          color: muted,
          fontSize,
          formatter: (v: number) => fmtAxisTick(v, kind),
        },
        splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
      },
      dataZoom: enableZoom ? [{ type: 'inside' }, { type: 'slider', height: 20, bottom: 6 }] : [],
      series,
    };
  };

  // Standard reactive update when records / settings / theme change
  useEffect(() => {
    if (!chartRef.current) return;
    const elapsed =
      isRunning && activeStep?.phase === 'compute'
        ? Math.max(0.01, (performance.now() - activeStep.startedAtMs) / 1000)
        : null;
    chartRef.current.setOption(buildOption(elapsed), { notMerge: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, records, hiddenAlgos, useLogScale, threadN, theme, plan, activeStep, isRunning, enableZoom, compact, forceBar]);

  // Dedicated 25fps rAF loop for LIVE GROWING active Time bar (outside React state!)
  useEffect(() => {
    if (kind !== 'time' || !isRunning || !activeStep || activeStep.phase !== 'compute') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let rafId = 0;
    let lastDraw = 0;
    const loop = (now: number) => {
      if (now - lastDraw >= 40) {
        lastDraw = now;
        const elapsed = Math.max(0.01, (performance.now() - activeStep.startedAtMs) / 1000);
        liveElapsedRef.current = elapsed;
        chartRef.current?.setOption(buildOption(elapsed), { notMerge: true });
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, isRunning, activeStep, records, hiddenAlgos, useLogScale, theme]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
});
