import type { AlgoKey, AlgoMeta, BenchmarkRecord, HybridState } from './types';

/**
 * 3 Semantic Color Families + Dual Encoding (Zero Violet, Zero Error-Red):
 * - CPU: Slate / Blue / Cyan-Teal + distinct dash styles & marker shapes
 * - Hybrid: Amber + diamond marker
 * - GPU: Teal & Emerald + bold 3px hero stroke
 */
export const ALGO_META: Record<AlgoKey, AlgoMeta> = {
  seq: {
    key: 'seq',
    name: 'Tuần tự Baseline',
    shortName: 'Tuần tự',
    csvName: '1. Tuan tu (Baseline)',
    color: '#64748b',
    group: 'cpu',
    lineStyle: 'dotted',
    symbol: 'circle',
    lineWidth: 2,
  },
  omp_basic: {
    key: 'omp_basic',
    name: 'OpenMP Cơ bản',
    shortName: 'OMP Cơ bản',
    csvName: '2. Song song OpenMP Co ban',
    color: '#2563eb',
    group: 'cpu',
    lineStyle: 'solid',
    symbol: 'circle',
    lineWidth: 2,
  },
  omp_l2_l3: {
    key: 'omp_l2_l3',
    name: 'OpenMP Tiled L2+L3',
    shortName: 'OMP Tiled',
    csvName: '3. Song song Tiled L2+L3',
    color: '#0e7490',
    group: 'cpu',
    lineStyle: 'dashed',
    symbol: 'rect',
    lineWidth: 2,
  },
  omp_bypass: {
    key: 'omp_bypass',
    name: 'OpenMP Bypass L2',
    shortName: 'OMP Bypass',
    csvName: '4. Song song Bypass L2',
    color: '#334155',
    group: 'cpu',
    lineStyle: 'dotted',
    symbol: 'triangle',
    lineWidth: 2,
  },
  hybrid: {
    key: 'hybrid',
    name: 'Hybrid CPU + CUDA',
    shortName: 'Hybrid α*',
    csvName: '5. Ket hop CPU + CUDA GPU',
    color: '#d97706',
    group: 'hybrid',
    lineStyle: 'solid',
    symbol: 'diamond',
    lineWidth: 2.8,
  },
  cuda_global: {
    key: 'cuda_global',
    name: 'CUDA Global Memory',
    shortName: 'CUDA Global',
    csvName: 'CUDA Global Memory',
    color: '#14b8a6',
    group: 'gpu',
    lineStyle: 'dashed',
    symbol: 'rect',
    lineWidth: 2.5,
  },
  cuda_shared: {
    key: 'cuda_shared',
    name: 'CUDA Shared Tiling',
    shortName: 'CUDA Shared',
    csvName: 'CUDA Shared Memory Tiling',
    color: '#059669',
    group: 'gpu',
    lineStyle: 'solid',
    symbol: 'circle',
    lineWidth: 3.2,
  },
};

export const ALGO_ORDER: AlgoKey[] = [
  'seq',
  'omp_basic',
  'omp_l2_l3',
  'omp_bypass',
  'hybrid',
  'cuda_global',
  'cuda_shared',
];

export const PRESETS = {
  quick: {
    id: 'quick' as const,
    label: 'Demo nhanh (~10s)',
    sizes: [512, 1024],
    threads: [1, 4, 8],
    runs: 1,
    cudaTile: 16 as const,
    algos: [...ALGO_ORDER] as AlgoKey[],
  },
  gpu: {
    id: 'gpu' as const,
    label: 'GPU & Hybrid (~8s)',
    sizes: [1024, 2048, 4096],
    threads: [8],
    runs: 1,
    cudaTile: 16 as const,
    algos: ['hybrid', 'cuda_global', 'cuda_shared'] as AlgoKey[],
  },
  full: {
    id: 'full' as const,
    label: 'Full Benchmark',
    sizes: [512, 1024, 2048],
    threads: [1, 2, 4, 8],
    runs: 3,
    cudaTile: 16 as const,
    algos: [...ALGO_ORDER] as AlgoKey[],
  },
};

export const DEFAULT_HYBRID: HybridState = {
  calib_n: 1024,
  perf_cpu: 15.1,
  t_cpu_cal: 0.1422,
  perf_gpu: 103.1,
  t_gpu_cal: 0.0208,
  alpha0: 0.8722,
  alpha_star: 0.875,
  imbalance: 1.032,
  from_cache: false,
  iterations: [
    { round: 1, m_gpu: 1792, m_cpu: 256, t_gpu: 0.1412, t_cpu: 0.1505, imbalance: 1.032 },
  ],
};

export function computeMetrics(
  records: Omit<BenchmarkRecord, 'gflops' | 'speedup'>[] | BenchmarkRecord[]
): BenchmarkRecord[] {
  const seqMap = new Map<number, number>();
  for (const r of records) {
    if (r.key === 'seq' && r.time > 0) seqMap.set(r.n, r.time);
  }
  return records.map((r) => {
    const flops = 2.0 * r.n * r.n * r.n;
    const gflops = 'gflops' in r && r.gflops > 0 ? r.gflops : r.time > 0 ? flops / (r.time * 1e9) : 0;
    const tSeq = seqMap.has(r.n) ? seqMap.get(r.n)! : flops / (6.2 * 1e9);
    const speedup = 'speedup' in r && r.speedup > 0 ? r.speedup : r.time > 0 ? tSeq / r.time : 0;
    return { ...r, gflops, speedup };
  });
}

export function detectAlgoKey(name: string): AlgoKey {
  const s = (name || '').toLowerCase();
  if (s.includes('tuan tu') || s.includes('baseline') || s.includes('seq')) return 'seq';
  if (s.includes('co ban') || s.includes('basic')) return 'omp_basic';
  if (s.includes('bypass')) return 'omp_bypass';
  if (s.includes('tiled') && !s.includes('cuda')) return 'omp_l2_l3';
  if (s.includes('ket hop') || s.includes('hybrid') || s.includes('cpu + cuda')) return 'hybrid';
  if (s.includes('global')) return 'cuda_global';
  if (s.includes('shared')) return 'cuda_shared';
  return 'omp_basic';
}

export const SAMPLE_RECORDS: BenchmarkRecord[] = computeMetrics([
  { id: 1, n: 512, threads: 1, key: 'seq', time: 0.043037, verified: true },
  { id: 2, n: 512, threads: 4, key: 'omp_basic', time: 0.042987, verified: true },
  { id: 3, n: 512, threads: 8, key: 'omp_basic', time: 0.032513, verified: true },
  { id: 4, n: 512, threads: 16, key: 'omp_basic', time: 0.028423, verified: true },
  { id: 5, n: 512, threads: 8, key: 'omp_l2_l3', time: 0.066385, verified: true },
  { id: 6, n: 512, threads: 8, key: 'omp_bypass', time: 0.065263, verified: true },
  { id: 7, n: 512, threads: 8, key: 'hybrid', time: 0.006867, verified: true },
  { id: 8, n: 512, threads: 16, key: 'hybrid', time: 0.006663, verified: true },
  { id: 9, n: 512, threads: 2560, key: 'cuda_global', time: 0.004652, verified: true },
  { id: 10, n: 512, threads: 2560, key: 'cuda_shared', time: 0.004423, verified: true },

  { id: 11, n: 1024, threads: 1, key: 'seq', time: 0.404824, verified: true },
  { id: 12, n: 1024, threads: 2, key: 'omp_basic', time: 0.445326, verified: true },
  { id: 13, n: 1024, threads: 4, key: 'omp_basic', time: 0.300551, verified: true },
  { id: 14, n: 1024, threads: 8, key: 'omp_basic', time: 0.226992, verified: true },
  { id: 15, n: 1024, threads: 16, key: 'omp_basic', time: 0.141951, verified: true },
  { id: 16, n: 1024, threads: 8, key: 'omp_l2_l3', time: 0.408417, verified: true },
  { id: 17, n: 1024, threads: 8, key: 'omp_bypass', time: 0.383927, verified: true },
  { id: 18, n: 1024, threads: 8, key: 'hybrid', time: 0.068812, verified: true },
  { id: 19, n: 1024, threads: 16, key: 'hybrid', time: 0.054814, verified: true },
  { id: 20, n: 1024, threads: 2560, key: 'cuda_global', time: 0.021556, verified: true },
  { id: 21, n: 1024, threads: 2560, key: 'cuda_shared', time: 0.020835, verified: true },

  { id: 22, n: 2048, threads: 8, key: 'omp_basic', time: 1.480612, verified: true },
  { id: 23, n: 2048, threads: 16, key: 'omp_basic', time: 1.331741, verified: true },
  { id: 24, n: 2048, threads: 8, key: 'omp_l2_l3', time: 1.818611, verified: true },
  { id: 25, n: 2048, threads: 16, key: 'omp_l2_l3', time: 1.804818, verified: true },
  { id: 26, n: 2048, threads: 8, key: 'omp_bypass', time: 1.976217, verified: true },
  { id: 27, n: 2048, threads: 16, key: 'omp_bypass', time: 2.050059, verified: true },
  { id: 28, n: 2048, threads: 8, key: 'hybrid', time: 0.408985, verified: true },
  { id: 29, n: 2048, threads: 16, key: 'hybrid', time: 0.312442, verified: true },
  { id: 30, n: 2048, threads: 2560, key: 'cuda_global', time: 0.131862, verified: true },
  { id: 31, n: 2048, threads: 2560, key: 'cuda_shared', time: 0.128934, verified: true },

  { id: 32, n: 4096, threads: 8, key: 'omp_basic', time: 12.298708, verified: true },
  { id: 33, n: 4096, threads: 16, key: 'omp_basic', time: 10.673928, verified: true },
  { id: 34, n: 4096, threads: 16, key: 'omp_l2_l3', time: 13.145053, verified: true },
  { id: 35, n: 4096, threads: 16, key: 'omp_bypass', time: 12.733192, verified: true },
  { id: 36, n: 4096, threads: 8, key: 'hybrid', time: 3.175659, verified: true },
  { id: 37, n: 4096, threads: 16, key: 'hybrid', time: 2.55372, verified: true },
  { id: 38, n: 4096, threads: 2560, key: 'cuda_global', time: 1.015614, verified: true },
  { id: 39, n: 4096, threads: 2560, key: 'cuda_shared', time: 0.979826, verified: true },
]);
