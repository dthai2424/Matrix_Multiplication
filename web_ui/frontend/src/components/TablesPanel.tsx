import { useState } from 'react';
import { ALGO_META } from '../data';
import type { AlgoGroup, BenchmarkRecord } from '../types';

interface TablesPanelProps {
  records: BenchmarkRecord[];
}

export function TablesPanel({ records }: TablesPanelProps) {
  const [subView, setSubView] = useState<'milestone' | 'detail'>('milestone');
  const [filterN, setFilterN] = useState<string>('all');
  const [filterGroup, setFilterGroup] = useState<'all' | AlgoGroup>('all');

  const uniqueN = [...new Set(records.map((r) => r.n))].sort((a, b) => a - b);

  const filtered = records.filter((r) => {
    if (filterN !== 'all' && r.n !== Number(filterN)) return false;
    if (filterGroup !== 'all' && ALGO_META[r.key].group !== filterGroup) return false;
    return true;
  });

  return (
    <div className="space-y-4 tabular">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-[var(--border)] bg-[var(--subtle)] p-0.5">
          <button
            type="button"
            onClick={() => setSubView('milestone')}
            className={`px-3 py-1.5 text-sm font-medium rounded cursor-pointer transition-colors ${
              subView === 'milestone'
                ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Đối chiếu theo mốc N
          </button>
          <button
            type="button"
            onClick={() => setSubView('detail')}
            className={`px-3 py-1.5 text-sm font-medium rounded cursor-pointer transition-colors ${
              subView === 'detail'
                ? 'bg-[var(--surface)] text-[var(--ink)] shadow-xs'
                : 'text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            Dữ liệu chi tiết ({records.length})
          </button>
        </div>

        {subView === 'detail' && (
          <div className="flex items-center gap-2">
            <select
              aria-label="Lọc theo N"
              value={filterN}
              onChange={(e) => setFilterN(e.target.value)}
              className="h-9 px-3 rounded-md text-xs font-semibold border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]"
            >
              <option value="all">Tất cả N ({uniqueN.length})</option>
              {uniqueN.map((n) => (
                <option key={n} value={n}>
                  N = {n}
                </option>
              ))}
            </select>
            <select
              aria-label="Lọc theo nhóm phần cứng"
              value={filterGroup}
              onChange={(e) => setFilterGroup(e.target.value as 'all' | AlgoGroup)}
              className="h-9 px-3 rounded-md text-xs font-semibold border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)]"
            >
              <option value="all">Tất cả nhóm</option>
              <option value="cpu">CPU thuần</option>
              <option value="hybrid">Hybrid CPU+GPU</option>
              <option value="gpu">GPU CUDA</option>
            </select>
          </div>
        )}
      </div>

      {subView === 'milestone' ? (
        <div tabIndex={0} role="region" aria-label="Bảng đối chiếu phương pháp tối ưu theo mốc N" className="table-wrap">
          <table className="data-tbl">
            <thead>
              <tr>
                <th>Kích thước N</th>
                <th>Phương pháp tối ưu</th>
                <th>CPU thuần tốt nhất</th>
                <th>Hybrid CPU+GPU</th>
                <th>GPU thuần tốt nhất</th>
                <th>Tỷ lệ GPU / CPU</th>
              </tr>
            </thead>
            <tbody>
              {!uniqueN.length ? (
                <tr>
                  <td colSpan={6} className="text-center text-[var(--muted)] py-8">
                    Chưa có dữ liệu đối chiếu.
                  </td>
                </tr>
              ) : (
                uniqueN.map((n) => {
                  const atN = records.filter((r) => r.n === n);
                  const best = atN.reduce((a, b) => (b.gflops > a.gflops ? b : a));
                  const cpus = atN.filter((r) => ALGO_META[r.key].group === 'cpu');
                  const hybs = atN.filter((r) => r.key === 'hybrid');
                  const gpus = atN.filter((r) => ALGO_META[r.key].group === 'gpu');
                  const bC = cpus.length ? cpus.reduce((a, b) => (b.gflops > a.gflops ? b : a)) : null;
                  const bH = hybs.length ? hybs.reduce((a, b) => (b.gflops > a.gflops ? b : a)) : null;
                  const bG = gpus.length ? gpus.reduce((a, b) => (b.gflops > a.gflops ? b : a)) : null;
                  const ratio =
                    bC && (bG || bH)
                      ? `${(Math.max(bG?.gflops ?? 0, bH?.gflops ?? 0) / bC.gflops).toFixed(2)}×`
                      : '—';

                  return (
                    <tr key={n}>
                      <th>N = {n}</th>
                      <td>
                        <span className="inline-flex items-center gap-2 font-semibold">
                          <span
                            className="w-2.5 h-2.5 rounded-xs"
                            style={{ background: ALGO_META[best.key].color }}
                          />
                          {ALGO_META[best.key].name} ({best.gflops.toFixed(1)} GFLOPS)
                        </span>
                      </td>
                      <td>
                        {bC ? (
                          <>
                            {ALGO_META[bC.key].shortName} ({bC.threads}T):{' '}
                            <strong>{bC.gflops.toFixed(1)}</strong>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {bH ? (
                          <>
                            {bH.threads}T: <strong>{bH.gflops.toFixed(1)}</strong>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {bG ? (
                          <>
                            {ALGO_META[bG.key].shortName}: <strong>{bG.gflops.toFixed(1)}</strong>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="font-bold text-[var(--accent)]">{ratio}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div tabIndex={0} role="region" aria-label="Bảng dữ liệu đo chi tiết" className="table-wrap">
          <table className="data-tbl">
            <thead>
              <tr>
                <th>Thuật toán</th>
                <th>N</th>
                <th>Luồng</th>
                <th>Thời gian (s)</th>
                <th>GFLOPS</th>
                <th>Speedup</th>
                <th>Kiểm định</th>
              </tr>
            </thead>
            <tbody>
              {!filtered.length ? (
                <tr>
                  <td colSpan={7} className="text-center text-[var(--muted)] py-8">
                    Không có bản ghi khớp bộ lọc.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const m = ALGO_META[r.key];
                  return (
                    <tr key={r.id}>
                      <th>
                        <span className="inline-flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-xs" style={{ background: m.color }} />
                          {m.name}
                        </span>
                      </th>
                      <td>{r.n}</td>
                      <td>{m.group === 'gpu' ? `${r.threads} CUDA` : `${r.threads}T`}</td>
                      <td className="font-mono">{r.time.toFixed(5)}</td>
                      <td className="font-mono font-semibold">{r.gflops.toFixed(2)}</td>
                      <td className="font-mono">{r.speedup.toFixed(2)}×</td>
                      <td
                        className={`font-semibold ${
                          r.verified ? 'text-[var(--ok)]' : 'text-[var(--danger)]'
                        }`}
                      >
                        {r.verified ? 'PASSED' : 'FAILED'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
