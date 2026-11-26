export type AlgoKey =
  | 'seq'
  | 'omp_basic'
  | 'omp_l2_l3'
  | 'omp_bypass'
  | 'hybrid'
  | 'cuda_global'
  | 'cuda_shared';

export type AlgoGroup = 'cpu' | 'hybrid' | 'gpu';

export interface AlgoMeta {
  key: AlgoKey;
  name: string;
  shortName: string;
  csvName: string;
  color: string;
  group: AlgoGroup;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  symbol: 'circle' | 'rect' | 'triangle' | 'diamond';
  lineWidth: number;
}

export interface BenchmarkRecord {
  id: number;
  n: number;
  threads: number;
  key: AlgoKey;
  time: number;
  gflops: number;
  speedup: number;
  verified: boolean;
}

export interface HardwareInfo {
  os: string;
  cpu: string;
  logical_cores: number;
  physical_cores: number;
  ram_gb: number;
  gpu: string;
  vram_mb: number;
  compute_cap: string;
  cuda_cores: number;
  has_gpu: boolean;
  binary_ready: boolean;
}

export interface HybridIteration {
  round: number;
  m_gpu: number;
  m_cpu: number;
  t_gpu: number;
  t_cpu: number;
  imbalance: number;
}

export interface HybridState {
  calib_n: number;
  perf_cpu: number | null;
  t_cpu_cal: number | null;
  perf_gpu: number | null;
  t_gpu_cal: number | null;
  alpha0: number | null;
  alpha_star: number;
  imbalance: number;
  from_cache: boolean;
  iterations: HybridIteration[];
}

export interface ExecutionPlan {
  sizes: number[];
  threads: number[];
  gpu_only: boolean;
  has_gpu: boolean;
  per_size: Record<string, number>;
  total_steps: number;
}

export interface ActiveStep {
  n: number;
  threads: number;
  key: AlgoKey | 'ref';
  label: string;
  phase: 'compute' | 'prep' | 'calibrate';
  startedAtMs: number;
}

export type MainTab = 'charts' | 'hybrid' | 'table';
export type ChartMetric = 'live_split' | 'gflops' | 'time' | 'speedup' | 'threads' | 'grid';
export type PresetId = 'quick' | 'gpu' | 'full' | 'custom';
