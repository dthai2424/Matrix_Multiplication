import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
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

export type ChartScope = 'auto' | 'all' | number;

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
  chartScope?: ChartScope;
}

function getBest(data: BenchmarkRecord[], n: number, key: AlgoKey): BenchmarkRecord | null {
  const list = data.filter((d) => d.n === n && d.key === key);
  if (!list.length) return null;
  return list.reduce((a, b) => (b.gflops > a.gflops ? b : a));
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms).toLocaleString('en-US')} ms`;
  if (ms >= 100) return `${ms.toFixed(0)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function fmtAxisTick(val: number, kind: ChartKind): string {
  if (val === 0) return '0';
  if (kind === 'time') {
    if (val >= 1000) return `${Math.round(val).toLocaleString('en-US')}ms`;
    if (val >= 10) return `${val.toFixed(0)}ms`;
    if (val >= 1) return `${val.toFixed(1)}ms`;
    return `${val.toFixed(2)}ms`;
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
    chartScope = 'auto',
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const prevStructKeyRef = useRef<string>('');

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

  // Build ECharts option + structural key (so incremental records animate smoothly without recreating existing bars)
  const buildOption = (): { option: EChartsCoreOption; structKey: string } => {
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
          structKey: `threads|empty|${targetN}|${theme}`,
          option: {
            title: {
              text: `Chưa có dữ liệu đa luồng CPU tại N = ${targetN}`,
              left: 'center',
              top: 'middle',
              textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
            },
            xAxis: { show: false },
            yAxis: { show: false },
            series: [],
          },
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
        structKey: `threads|data|${targetN}|${theme}|${enableZoom}|${compact}|${scaleKeys.join(',')}`,
        option: {
          animation: !reducedMotion,
          animationDuration: 320,
          animationDurationUpdate: 260,
          animationEasing: 'cubicOut',
          animationEasingUpdate: 'cubicOut',
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
        },
      };
    }

    // -------------------------------------------------------------------------
    // MODE B: HORIZONTAL BAR (Specific selected N, OR active running N in 'auto', OR single N)
    // No live-growing jitter: bars stay empty until a kernel finishes, then rise crisply!
    // Multi-N Line+Dot curves appear when chartScope === 'all' (or 'auto' after finishing >=2 N).
    // -------------------------------------------------------------------------
    const isSpecificN = typeof chartScope === 'number';
    const canShowMultiLine = measuredNs.length >= 2;
    const showBarView =
      isSpecificN ||
      (chartScope === 'auto' && (isRunning || !canShowMultiLine)) ||
      (chartScope === 'all' && !canShowMultiLine);

    if (showBarView) {
      const targetN = isSpecificN
        ? chartScope
        : (isRunning && activeStep?.n) ||
          measuredNs[measuredNs.length - 1] ||
          allNs[allNs.length - 1] ||
          plan?.sizes?.[0] ||
          512;

      const isTargetRunning = isRunning && activeStep?.n === targetN;

      const algoKeys = ALGO_ORDER.filter((k) => {
        if (hiddenAlgos.has(k)) return false;
        if (k === 'seq' && targetN >= 2048) return false;
        if (isTargetRunning) {
          if (plan?.algos?.length) return plan.algos.includes(k);
          if (plan?.gpu_only && ALGO_META[k].group === 'cpu') return false;
          return true;
        }
        return visible.some((r) => r.n === targetN && r.key === k);
      });

      interface BarRow {
        key: AlgoKey;
        name: string;
        value: number | null;
        rec: BenchmarkRecord | null;
      }

      const rows: BarRow[] = algoKeys.map((k) => {
        const rec = getBest(visible, targetN, k);
        const val = rec
          ? kind === 'gflops'
            ? rec.gflops
            : kind === 'time'
            ? rec.time * 1000
            : rec.speedup
          : null;
        return { key: k, name: ALGO_META[k].name, value: val, rec };
      });

      // Completed N: sort cleanly by performance. Currently running N: keep GPU at top (index n-1 in ECharts Y-axis) -> CPU below so bars appear top-down!
      if (!isTargetRunning) {
        rows.sort((a, b) => {
          const av = a.value ?? -1;
          const bv = b.value ?? -1;
          return kind === 'time' ? bv - av : av - bv;
        });
      }

      const hasAnyValue = rows.some((r) => r.value != null && r.value > 0);
      if (!hasAnyValue) {
        return {
          structKey: `bar|empty|${kind}|${targetN}|${theme}|${isTargetRunning}`,
          option: {
            title: {
              text: isTargetRunning
                ? `Đang đo N = ${targetN}... cột sẽ hiện lên ngay khi từng thuật toán xong`
                : isRunning
                ? `N = ${targetN} chưa đến lượt đo`
                : `Chưa có dữ liệu cho N = ${targetN}`,
              left: 'center',
              top: 'middle',
              textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
            },
            xAxis: { show: false },
            yAxis: { show: false },
            series: [],
          },
        };
      }

      const logAxis = useLogScale;
      const unitLabel =
        kind === 'gflops'
          ? `GFLOPS (N=${targetN})`
          : kind === 'time'
          ? `Thời gian (ms · N=${targetN})`
          : `Speedup (× · N=${targetN})`;

      return {
        structKey: `bar|data|${kind}|${targetN}|${theme}|${logAxis}|${enableZoom}|${compact}|${isTargetRunning}|${rows.map((r) => r.key).join(',')}`,
        option: {
          animation: !reducedMotion,
          animationDuration: 300,
          animationDurationUpdate: 280,
          animationEasing: 'cubicOut',
          animationEasingUpdate: 'cubicOut',
          grid: {
            top: compact ? 18 : 26,
            right: compact ? 84 : 122,
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
              if (!row.rec) return `<strong>${row.name}</strong><br/><span style="color:${muted}">Đang chờ thực thi...</span>`;
              const tag = ALGO_META[row.key].group === 'gpu' ? 'GPU CUDA' : `${row.rec.threads}T`;
              return `<div style="font-variant-numeric:tabular-nums">
              <strong>${row.name}</strong> · N = ${targetN} (${tag})<br/>
              Hiệu năng: <strong>${row.rec.gflops.toFixed(2)} GFLOPS</strong><br/>
              Thời gian: <strong>${fmtMs(row.rec.time * 1000)}</strong><br/>
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
              id: `bar-${kind}`,
              type: 'bar',
              barMaxWidth: compact ? 22 : 30,
              universalTransition: !isRunning,
              data: rows.map((r) => {
                const color = ALGO_META[r.key].color;
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
                      if (kind === 'time') return fmtMs(r.value);
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
        },
      };
    }

    // -------------------------------------------------------------------------
    // MODE C: MULTI-N LINE + DOT CHART (Clean Scaling Curves across N=512..4096)
    // -------------------------------------------------------------------------
    if (!allNs.length || !presentKeys.length) {
      return {
        structKey: `line|empty|${kind}|${theme}`,
        option: {
          title: {
            text: 'Chưa có dữ liệu — bấm Chạy thực nghiệm để vẽ biểu đồ',
            left: 'center',
            top: 'middle',
            textStyle: { color: muted, fontSize: 14, fontWeight: 500 },
          },
          xAxis: { show: false },
          yAxis: { show: false },
          series: [],
        },
      };
    }

    const logAxis = useLogScale;
    const unitLabel =
      kind === 'gflops' ? 'GFLOPS' : kind === 'time' ? 'Thời gian (ms)' : 'Speedup (×)';

    // Smart end-of-line direct labels: avoid overlaps on Linear scale by labeling top GPU, Hybrid, and top CPU
    const lastN = measuredNs[measuredNs.length - 1];
    const lastVals = presentKeys
      .map((k) => {
        const r = lastN ? getBest(visible, lastN, k) : null;
        const v = r ? (kind === 'gflops' ? r.gflops : kind === 'time' ? r.time * 1000 : r.speedup) : null;
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
                ? fmtMs(v)
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
          const v = kind === 'gflops' ? rec.gflops : kind === 'time' ? rec.time * 1000 : rec.speedup;
          return { value: Number(v.toFixed(2)), raw: rec };
        }),
      };
    });

    return {
      structKey: `line|data|${kind}|${theme}|${logAxis}|${enableZoom}|${compact}|${presentKeys.join(',')}`,
      option: {
        animation: !reducedMotion,
        animationDuration: 320,
        animationDurationUpdate: 260,
        animationEasing: 'cubicOut',
        animationEasingUpdate: 'cubicOut',
        grid: {
          top: compact ? 22 : 28,
          right: compact ? 26 : 156,
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
                    ? fmtMs(v)
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
      },
    };
  };

  // Reactive update: smooth incremental rise when only records change; full replace on structural changes
  useEffect(() => {
    if (!chartRef.current) return;
    const { option, structKey } = buildOption();
    const shouldReplace = prevStructKeyRef.current !== structKey;
    prevStructKeyRef.current = structKey;
    chartRef.current.setOption(option, { notMerge: shouldReplace });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, records, hiddenAlgos, useLogScale, threadN, theme, plan, activeStep, isRunning, enableZoom, compact, chartScope]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
});
