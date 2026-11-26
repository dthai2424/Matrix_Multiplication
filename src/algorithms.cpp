#include "algorithms.h"
#include "cuda_backend.h"
#include <omp.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>

#if defined(_MSC_VER)
#define RESTRICT_PTR __restrict
#elif defined(__GNUC__) || defined(__clang__)
#define RESTRICT_PTR __restrict__
#else
#define RESTRICT_PTR
#endif

namespace
{
    constexpr const char *kHybridCfgFile = "hybrid_alpha.cfg";
    constexpr int kCalibSize = 1024;   // Kích thước ma trận chấm điểm Bước 1 (N_cal)
    constexpr int kTuneSize = 2048;    // Kích thước ma trận tinh chỉnh Bước 3 (N_tune)
    constexpr int kCpuHybridTile = 32; // Khối nhỏ thân thiện L1/L2 Cache cho CPU (Hybrid Tile)
    constexpr int kAlignStep = 64;     // Bước căn chỉnh hàng GPU (bội số 64 cho FP64)
    constexpr int kMaxTuneIters = 3;   // Tối đa 3 vòng tinh chỉnh thực nghiệm

    std::mutex g_hybrid_mutex;
    std::string g_cpu_name;
    std::string g_gpu_name;
    // Cache bộ nhớ trong theo (cpu, gpu, num_threads, cuda_tile) -> alpha*
    std::map<std::tuple<std::string, std::string, int, int>, double> g_alpha_cache;

    std::string sanitize_cfg_field(const std::string &value)
    {
        std::string out;
        out.reserve(value.size());
        for (char ch : value)
        {
            if (ch == '|' || ch == '\r' || ch == '\n')
                out.push_back(' ');
            else
                out.push_back(ch);
        }
        size_t start = out.find_first_not_of(" \t");
        if (start == std::string::npos)
            return "Unknown";
        size_t end = out.find_last_not_of(" \t");
        return out.substr(start, end - start + 1);
    }

    void resolve_hw_names_locked(std::string &cpu_out, std::string &gpu_out)
    {
        if (g_cpu_name.empty())
            g_cpu_name = "Generic-CPU";
        if (g_gpu_name.empty() && cuda_backend_available())
        {
            std::string detected_gpu, cuda_ver;
            int maj = 0, min = 0, sms = 0, cores = 0;
            size_t vram = 0;
            cuda_backend_device_info(detected_gpu, maj, min, vram, sms, cores, cuda_ver);
            g_gpu_name = detected_gpu.empty() ? "CUDA-GPU" : detected_gpu;
        }
        if (g_gpu_name.empty())
            g_gpu_name = "No-CUDA-GPU";

        cpu_out = sanitize_cfg_field(g_cpu_name);
        gpu_out = sanitize_cfg_field(g_gpu_name);
    }

    struct HybridCfgEntry
    {
        std::string cpu;
        std::string gpu;
        int threads = 1;
        int cuda_tile = 16;
        double alpha = 0.8;
        double imbalance = 1.0;
    };

    bool parse_cfg_line(const std::string &line, HybridCfgEntry &entry)
    {
        if (line.empty() || line[0] == '#')
            return false;
        std::stringstream ss(line);
        std::string token;
        int parsed_mask = 0;
        while (std::getline(ss, token, '|'))
        {
            size_t eq = token.find('=');
            if (eq == std::string::npos)
                continue;
            std::string key = token.substr(0, eq);
            std::string val = token.substr(eq + 1);
            try
            {
                if (key == "cpu")
                {
                    entry.cpu = sanitize_cfg_field(val);
                    parsed_mask |= 1;
                }
                else if (key == "gpu")
                {
                    entry.gpu = sanitize_cfg_field(val);
                    parsed_mask |= 2;
                }
                else if (key == "threads")
                {
                    entry.threads = std::stoi(val);
                    parsed_mask |= 4;
                }
                else if (key == "cuda_tile")
                {
                    entry.cuda_tile = std::stoi(val);
                    parsed_mask |= 8;
                }
                else if (key == "alpha")
                {
                    entry.alpha = std::stod(val);
                    parsed_mask |= 16;
                }
                else if (key == "imbalance")
                {
                    entry.imbalance = std::stod(val);
                }
            }
            catch (...)
            {
                return false;
            }
        }
        return (parsed_mask == 31) && (entry.alpha > 0.0 && entry.alpha < 1.0);
    }

    bool load_alpha_from_cfg(const std::string &cpu, const std::string &gpu,
                             int num_threads, int cuda_tile, double &alpha_out,
                             double &imbalance_out)
    {
        std::ifstream in(kHybridCfgFile);
        if (!in.is_open())
            return false;
        std::string line;
        while (std::getline(in, line))
        {
            HybridCfgEntry entry;
            if (parse_cfg_line(line, entry) &&
                entry.cpu == cpu && entry.gpu == gpu &&
                entry.threads == num_threads && entry.cuda_tile == cuda_tile)
            {
                alpha_out = entry.alpha;
                imbalance_out = entry.imbalance;
                return true;
            }
        }
        return false;
    }

    void save_alpha_to_cfg(const HybridCfgEntry &new_entry)
    {
        std::vector<HybridCfgEntry> entries;
        {
            std::ifstream in(kHybridCfgFile);
            std::string line;
            while (std::getline(in, line))
            {
                HybridCfgEntry entry;
                if (parse_cfg_line(line, entry))
                {
                    entries.push_back(entry);
                }
            }
        }

        bool replaced = false;
        for (auto &entry : entries)
        {
            if (entry.cpu == new_entry.cpu && entry.gpu == new_entry.gpu &&
                entry.threads == new_entry.threads && entry.cuda_tile == new_entry.cuda_tile)
            {
                entry = new_entry;
                replaced = true;
                break;
            }
        }
        if (!replaced)
        {
            entries.push_back(new_entry);
        }

        std::ofstream out(kHybridCfgFile, std::ios::trunc);
        if (!out.is_open())
            return;
        out << "# Heterogeneous CPU-GPU Load Balancing Configuration\n";
        out << "# Format: cpu=<CPU>|gpu=<GPU>|threads=<T>|cuda_tile=<K>|alpha=<alpha*>|imbalance=<ratio>\n";
        for (const auto &e : entries)
        {
            out << "cpu=" << e.cpu
                << "|gpu=" << e.gpu
                << "|threads=" << e.threads
                << "|cuda_tile=" << e.cuda_tile
                << "|alpha=" << std::fixed << std::setprecision(6) << e.alpha
                << "|imbalance=" << std::fixed << std::setprecision(4) << e.imbalance
                << "\n";
        }
    }

    int compute_aligned_gpu_rows(int n, double alpha, int cuda_tile)
    {
        // Căn chỉnh số hàng GPU theo bội số S = 64 (hoặc cuda_tile với ma trận nhỏ)
        // để khớp kích thước Tile/Warp trên GPU, tránh sụt hiệu năng do lệch biên.
        const int step = (n >= 2 * kAlignStep) ? kAlignStep : std::max(1, cuda_tile);
        int gpu_rows = static_cast<int>(std::floor((alpha * n) / step)) * step;
        if (gpu_rows <= 0)
        {
            gpu_rows = std::min(step, n - 1);
        }
        if (gpu_rows >= n)
        {
            gpu_rows = std::max(1, n - step);
        }
        return std::clamp(gpu_rows, 1, n - 1);
    }

    // Kernel CPU OpenMP Cache Tiling xử lý độc lập dải hàng [row_begin, row_end)
    // Phân tầng 3 cấp: Dải K_L3=256 giữ B trong L3 Shared Cache, phân khối (bi=16, bk=32, bj=64) trong L1/L2 Cache
    void matmul_omp_tiled_rows(const Matrix &A, const Matrix &B, Matrix &C,
                               int row_begin, int row_end, int num_threads,
                               int tile_size)
    {
        const int n = A.size();
        if (row_begin >= row_end || n <= 0)
            return;

        const double *RESTRICT_PTR a = A.data();
        const double *RESTRICT_PTR b = B.data();
        double *RESTRICT_PTR c = C.data();

        const int bs_l3 = 256;
        const int bk = std::max(16, tile_size);
        const int bj = std::max(32, tile_size * 2);
        const int bi = 16;

        const int num_i_blocks = (row_end - row_begin + bi - 1) / bi;
        const int num_j_blocks = (n + bj - 1) / bj;
        const int total_blocks = num_i_blocks * num_j_blocks;

#pragma omp parallel num_threads(num_threads)
        {
            for (int k_l3 = 0; k_l3 < n; k_l3 += bs_l3)
            {
                const int k_l3_end = std::min(k_l3 + bs_l3, n);

#pragma omp for schedule(static)
                for (int blk = 0; blk < total_blocks; ++blk)
                {
                    const int ib = blk / num_j_blocks;
                    const int jb = blk % num_j_blocks;
                    const int i0 = row_begin + ib * bi;
                    const int i_end = std::min(i0 + bi, row_end);
                    const int j0 = jb * bj;
                    const int j_end = std::min(j0 + bj, n);

                    if (k_l3 == 0)
                    {
                        for (int i = i0; i < i_end; ++i)
                        {
                            double *RESTRICT_PTR c_row = c + static_cast<size_t>(i) * n;
                            std::fill(c_row + j0, c_row + j_end, 0.0);
                        }
                    }

                    for (int k0 = k_l3; k0 < k_l3_end; k0 += bk)
                    {
                        const int k_end = std::min(k0 + bk, k_l3_end);
                        for (int i = i0; i < i_end; ++i)
                        {
                            const double *RESTRICT_PTR a_row = a + static_cast<size_t>(i) * n;
                            double *RESTRICT_PTR c_row = c + static_cast<size_t>(i) * n;
                            for (int k = k0; k < k_end; ++k)
                            {
                                const double a_value = a_row[k];
                                const double *RESTRICT_PTR b_row = b + static_cast<size_t>(k) * n;
#pragma omp simd
                                for (int j = j0; j < j_end; ++j)
                                {
                                    c_row[j] += a_value * b_row[j];
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    struct HybridTiming
    {
        double t_cpu = 0.0;
        double t_gpu = 0.0;
    };

    // Bước 4: Tách riêng 1 std::thread quản lý GPU + (n - 1) luồng OpenMP tính toán CPU
    HybridTiming execute_hybrid_split(const Matrix &A, const Matrix &B, Matrix &C,
                                      int num_threads, int gpu_rows, int cuda_tile)
    {
        const int n = A.size();
        const int cpu_threads = std::max(1, num_threads - 1);
        HybridTiming timing;
        std::exception_ptr gpu_error = nullptr;

        // Luồng quản lý GPU (đẩy A_gpu + B xuống VRAM, chạy CUDA Shared Memory, chép C_gpu về RAM)
        std::thread gpu_thread([&]()
                               {
            try
            {
                const double t0 = omp_get_wtime();
                if (!matmul_cuda_rows(A.data(), B.data(), C.data(), n, gpu_rows, cuda_tile))
                {
                    throw std::runtime_error("CUDA row multiplication did not complete");
                }
                timing.t_gpu = omp_get_wtime() - t0;
            }
            catch (...)
            {
                gpu_error = std::current_exception();
            } });

        // Đồng thời trên luồng chính: gọi OpenMP Cache Tiling với (n - 1) luồng tính phần của CPU
        const double t_cpu_start = omp_get_wtime();
        if (gpu_rows < n)
        {
            matmul_omp_tiled_rows(A, B, C, gpu_rows, n, cpu_threads, kCpuHybridTile);
        }
        timing.t_cpu = omp_get_wtime() - t_cpu_start;

        gpu_thread.join();
        if (gpu_error)
        {
            std::rethrow_exception(gpu_error);
        }
        return timing;
    }
} // namespace

// 1. Thuật toán tuần tự nguyên bản (Sequential Baseline)
void matmul_sequential(const Matrix &A, const Matrix &B, Matrix &C)
{
    int N = A.size();
    C.zero();
    const double *a = A.data();
    const double *b = B.data();
    double *c = C.data();

    for (int i = 0; i < N; ++i)
    {
        for (int k = 0; k < N; ++k)
        {
            double a_ik = a[i * N + k];
#pragma omp simd
            for (int j = 0; j < N; ++j)
            {
                c[i * N + j] += a_ik * b[k * N + j];
            }
        }
    }
}

// 2. Thuật toán song song OpenMP cơ bản (Basic OpenMP Parallel)
void matmul_omp_basic(const Matrix &A, const Matrix &B, Matrix &C, int num_threads)
{
    int N = A.size();
    C.zero();
    const double *a = A.data();
    const double *b = B.data();
    double *c = C.data();

#pragma omp parallel for num_threads(num_threads) schedule(static)
    for (int i = 0; i < N; ++i)
    {
        for (int k = 0; k < N; ++k)
        {
            double a_ik = a[i * N + k];
#pragma omp simd
            for (int j = 0; j < N; ++j)
            {
                c[i * N + j] += a_ik * b[k * N + j];
            }
        }
    }
}

// 3. Thuật toán song song OpenMP phân cấp L2 + L3 (Tiled L2/L3 Parallel)
// Thiết kế khớp Mục 3.6.2 tài liệu nghiên cứu:
// Siêu khối Tile3 (L3 Cache), khối con Tile2 (L2 Cache), vi khối Tile1 (L1 & SIMD)
void matmul_omp_tiled_l2_l3(const Matrix &A, const Matrix &B, Matrix &C,
                            int num_threads,
                            int bs_l3, int bs_l2, int bs_l1)
{
    int N = A.size();
    C.zero();
    const double *a = A.data();
    const double *b = B.data();
    double *c = C.data();

    // Điều chỉnh kích thước khối cho hợp lý với kích thước N
    if (bs_l3 > N)
        bs_l3 = N;
    if (bs_l2 > bs_l3)
        bs_l2 = bs_l3;
    if (bs_l1 > bs_l2)
        bs_l1 = bs_l2;

// Song song hóa trên các dải siêu khối hàng I
#pragma omp parallel for num_threads(num_threads) schedule(static)
    for (int I = 0; I < N; I += bs_l3)
    {
        int I_end = std::min(I + bs_l3, N);

        // Duyệt theo K (Tile3 của A và B nằm gọn trong L3 Cache dùng chung)
        for (int K = 0; K < N; K += bs_l3)
        {
            int K_end = std::min(K + bs_l3, N);

            // Duyệt theo J (Tile3 của B và C)
            for (int J = 0; J < N; J += bs_l3)
            {
                int J_end = std::min(J + bs_l3, N);

                // Khối Tile2 - L2 Cache của từng nhân CPU
                for (int ii = I; ii < I_end; ii += bs_l2)
                {
                    int ii_end = std::min(ii + bs_l2, I_end);

                    for (int kk = K; kk < K_end; kk += bs_l2)
                    {
                        int kk_end = std::min(kk + bs_l2, K_end);

                        for (int jj = J; jj < J_end; jj += bs_l2)
                        {
                            int jj_end = std::min(jj + bs_l2, J_end);

                            // Khối Tile1 - L1 Data Cache & Register micro-kernel
                            for (int iii = ii; iii < ii_end; iii += bs_l1)
                            {
                                int iii_end = std::min(iii + bs_l1, ii_end);

                                for (int kkk = kk; kkk < kk_end; kkk += bs_l1)
                                {
                                    int kkk_end = std::min(kkk + bs_l1, kk_end);

                                    for (int jjj = jj; jjj < jj_end; jjj += bs_l1)
                                    {
                                        int jjj_end = std::min(jjj + bs_l1, jj_end);

                                        // Vòng lặp tính toán vi mô tối ưu thanh ghi CPU & vector hóa AVX2
                                        for (int i = iii; i < iii_end; ++i)
                                        {
                                            for (int k = kkk; k < kkk_end; ++k)
                                            {
                                                double a_val = a[i * N + k];
#pragma omp simd
                                                for (int j = jjj; j < jjj_end; ++j)
                                                {
                                                    c[i * N + j] += a_val * b[k * N + j];
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// 4. Thuật toán song song OpenMP L3 + L1 "Bỏ qua L2" (Bypass L2 Tiled Parallel)
// Khớp theo Mục 3.6.3 trong tài liệu:
// Dữ liệu từ L3 được bơm trực tiếp xuống L1 Data Cache của từng nhân,
// loại bỏ chi phí đánh chỉ mục và nạp trung gian qua L2.
void matmul_omp_tiled_l3_l1_bypass(const Matrix &A, const Matrix &B, Matrix &C,
                                   int num_threads,
                                   int bs_l3, int bs_l1)
{
    int N = A.size();
    C.zero();
    const double *a = A.data();
    const double *b = B.data();
    double *c = C.data();

    if (bs_l3 > N)
        bs_l3 = N;
    if (bs_l1 > bs_l3)
        bs_l1 = bs_l3;

#pragma omp parallel for num_threads(num_threads) schedule(static)
    for (int I = 0; I < N; I += bs_l3)
    {
        int I_end = std::min(I + bs_l3, N);

        for (int K = 0; K < N; K += bs_l3)
        {
            int K_end = std::min(K + bs_l3, N);

            for (int J = 0; J < N; J += bs_l3)
            {
                int J_end = std::min(J + bs_l3, N);

                // Đi thẳng từ khối L3 xuống các khối L1 nhỏ của từng nhân
                for (int ii = I; ii < I_end; ii += bs_l1)
                {
                    int ii_end = std::min(ii + bs_l1, I_end);

                    for (int kk = K; kk < K_end; kk += bs_l1)
                    {
                        int kk_end = std::min(kk + bs_l1, K_end);

                        for (int jj = J; jj < J_end; jj += bs_l1)
                        {
                            int jj_end = std::min(jj + bs_l1, J_end);

                            for (int i = ii; i < ii_end; ++i)
                            {
                                for (int k = kk; k < kk_end; ++k)
                                {
                                    double a_val = a[i * N + k];
#pragma omp simd
                                    for (int j = jj; j < jj_end; ++j)
                                    {
                                        c[i * N + j] += a_val * b[k * N + j];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

void set_heterogeneous_hardware_names(const std::string &cpu_name,
                                      const std::string &gpu_name)
{
    std::lock_guard<std::mutex> lock(g_hybrid_mutex);
    g_cpu_name = cpu_name;
    g_gpu_name = gpu_name;
}

double tune_heterogeneous_gpu_fraction(int num_threads, int cuda_tile, bool verbose)
{
    if (!cuda_backend_available())
    {
        throw std::runtime_error(
            "CUDA backend is unavailable. Build with 'make CUDA_ENABLED=1' "
            "and use a CUDA-capable NVIDIA device.");
    }
    if (num_threads <= 0)
    {
        throw std::invalid_argument("CPU thread count must be positive");
    }
    if (cuda_tile != 16 && cuda_tile != 32)
    {
        throw std::invalid_argument("CUDA tile size must be 16 or 32");
    }

    std::lock_guard<std::mutex> lock(g_hybrid_mutex);
    std::string cpu_id, gpu_id;
    resolve_hw_names_locked(cpu_id, gpu_id);

    const auto key = std::make_tuple(cpu_id, gpu_id, num_threads, cuda_tile);
    auto cached = g_alpha_cache.find(key);
    if (cached != g_alpha_cache.end())
    {
        return cached->second;
    }

    // Kiểm tra file cấu hình hybrid_alpha.cfg nếu đã hiệu chỉnh trước đó
    double loaded_alpha = 0.0;
    double loaded_imb = 1.0;
    if (load_alpha_from_cfg(cpu_id, gpu_id, num_threads, cuda_tile, loaded_alpha, loaded_imb))
    {
        g_alpha_cache[key] = loaded_alpha;
        if (verbose)
        {
            std::cout << "       [Can bang tai Hybrid] Nap alpha* = " << std::fixed << std::setprecision(4)
                      << loaded_alpha << " (Imbalance=" << std::setprecision(3) << loaded_imb
                      << ") tu " << kHybridCfgFile << "\n";
        }
        return loaded_alpha;
    }

    const int cpu_threads = std::max(1, num_threads - 1);
    if (verbose)
    {
        std::cout << "       [Can bang tai Hybrid] Dang do hieu chinh ti le chia tai (" << cpu_threads
                  << " CPU + 1 GPU thread, Tile " << cuda_tile << "):\n";
    }

    // Bước 1: Chấm điểm thực lực (Micro-Benchmarking) trên N_cal = 1024
    Matrix A_cal(kCalibSize), B_cal(kCalibSize), C_cal(kCalibSize);
    A_cal.fill_random(0.5, 2.5, 31415);
    B_cal.fill_random(0.5, 2.5, 27182);

    // Warm-up làm nóng phần cứng CPU và GPU (CUDA context)
    matmul_omp_tiled_rows(A_cal, B_cal, C_cal, 0, kCalibSize, cpu_threads, kCpuHybridTile);
    if (!matmul_cuda_rows(A_cal.data(), B_cal.data(), C_cal.data(), kCalibSize, kCalibSize, cuda_tile))
    {
        throw std::runtime_error("CUDA calibration warm-up failed");
    }

    const double t_cpu_start = omp_get_wtime();
    matmul_omp_tiled_rows(A_cal, B_cal, C_cal, 0, kCalibSize, cpu_threads, kCpuHybridTile);
    const double t_cpu_cal = std::max(1e-9, omp_get_wtime() - t_cpu_start);

    const double t_gpu_start = omp_get_wtime();
    if (!matmul_cuda_rows(A_cal.data(), B_cal.data(), C_cal.data(), kCalibSize, kCalibSize, cuda_tile))
    {
        throw std::runtime_error("CUDA calibration timing failed");
    }
    const double t_gpu_cal = std::max(1e-9, omp_get_wtime() - t_gpu_start);

    const double flops_cal = 2.0 * static_cast<double>(kCalibSize) * kCalibSize * kCalibSize;
    const double perf_cpu = flops_cal / (t_cpu_cal * 1e9);
    const double perf_gpu = flops_cal / (t_gpu_cal * 1e9);

    // Bước 2: Ước lượng tỷ lệ chia tải ban đầu alpha_0
    double alpha = std::clamp(perf_gpu / (perf_cpu + perf_gpu), 0.05, 0.97);

    if (verbose)
    {
        std::cout << "         * Buoc 1 (N=" << kCalibSize << "): CPU = " << std::fixed << std::setprecision(1)
                  << perf_cpu << " GFLOPS (" << std::setprecision(4) << t_cpu_cal << "s) | GPU = "
                  << std::setprecision(1) << perf_gpu << " GFLOPS (" << std::setprecision(4)
                  << t_gpu_cal << "s)\n";
        std::cout << "         * Buoc 2 (Alpha0): alpha0 = " << std::setprecision(4) << alpha << "\n";
    }

    // Bước 3: Tinh chỉnh thực nghiệm tối đa 3 vòng trên N_tune = 2048
    Matrix A_tune(kTuneSize), B_tune(kTuneSize), C_tune(kTuneSize);
    A_tune.fill_random(0.5, 2.5, 11235);
    B_tune.fill_random(0.5, 2.5, 81321);

    double best_alpha = alpha;
    double best_imbalance = 1e9;
    int prev_m_gpu = -1;

    for (int iter = 0; iter < kMaxTuneIters; ++iter)
    {
        int m_gpu = compute_aligned_gpu_rows(kTuneSize, alpha, cuda_tile);
        if (iter > 0 && m_gpu == prev_m_gpu)
        {
            const int step = kAlignStep;
            const int delta = (alpha * kTuneSize > prev_m_gpu) ? step : -step;
            const int nudged = std::clamp(m_gpu + delta, step, kTuneSize - step);
            if (nudged == prev_m_gpu)
            {
                break;
            }
            m_gpu = nudged;
        }
        prev_m_gpu = m_gpu;

        const double alpha_actual = static_cast<double>(m_gpu) / kTuneSize;
        const HybridTiming tm = execute_hybrid_split(A_tune, B_tune, C_tune, num_threads, m_gpu, cuda_tile);
        const double avg_t = 0.5 * (tm.t_cpu + tm.t_gpu);
        const double imbalance = (avg_t > 0.0) ? (std::max(tm.t_cpu, tm.t_gpu) / avg_t) : 1.0;

        if (imbalance < best_imbalance)
        {
            best_imbalance = imbalance;
            best_alpha = alpha_actual;
        }

        if (verbose)
        {
            std::cout << "         * Buoc 3 (Vong " << (iter + 1) << "): M_GPU=" << m_gpu
                      << ", M_CPU=" << (kTuneSize - m_gpu)
                      << " | t_GPU=" << std::fixed << std::setprecision(4) << tm.t_gpu
                      << "s, t_CPU=" << tm.t_cpu
                      << "s | Imbalance=" << std::setprecision(3) << imbalance << "\n";
        }

        if (imbalance <= 1.05)
        {
            break;
        }

        const double rate_gpu = alpha_actual / std::max(1e-9, tm.t_gpu);
        const double rate_cpu = (1.0 - alpha_actual) / std::max(1e-9, tm.t_cpu);
        alpha = std::clamp(rate_gpu / (rate_gpu + rate_cpu), 0.05, 0.97);
    }

    if (verbose)
    {
        std::cout << "         -> Chot alpha* = " << std::fixed << std::setprecision(4) << best_alpha
                  << " (Imbalance=" << std::setprecision(3) << best_imbalance
                  << "), da luu vao " << kHybridCfgFile << "\n";
    }

    g_alpha_cache[key] = best_alpha;
    save_alpha_to_cfg({cpu_id, gpu_id, num_threads, cuda_tile, best_alpha, best_imbalance});
    return best_alpha;
}

void matmul_heterogeneous_omp_cuda(const Matrix &A, const Matrix &B, Matrix &C,
                                   int num_threads, double gpu_fraction,
                                   int cuda_tile)
{
    if (!cuda_backend_available())
    {
        throw std::runtime_error(
            "CUDA backend is unavailable. Build with 'make CUDA_ENABLED=1' "
            "and use a CUDA-capable NVIDIA device.");
    }
    if (A.size() != B.size() || A.size() != C.size())
    {
        throw std::invalid_argument("Heterogeneous matmul requires equal matrix sizes");
    }
    if (num_threads <= 0)
    {
        throw std::invalid_argument("CPU thread count must be positive");
    }
    if (A.size() < 2)
    {
        throw std::invalid_argument("Heterogeneous matmul requires N >= 2");
    }
    if (gpu_fraction >= 1.0 || std::isnan(gpu_fraction))
    {
        throw std::invalid_argument("gpu_fraction must be <= 0 (auto) or in (0, 1)");
    }

    double effective_fraction = gpu_fraction;
    if (effective_fraction <= 0.0)
    {
        effective_fraction = tune_heterogeneous_gpu_fraction(num_threads, cuda_tile, false);
    }

    const int n = A.size();
    const int gpu_rows = compute_aligned_gpu_rows(n, effective_fraction, cuda_tile);
    execute_hybrid_split(A, B, C, num_threads, gpu_rows, cuda_tile);
}

namespace
{
    void validate_cuda_matrices(const Matrix &A, const Matrix &B, const Matrix &C)
    {
        if (A.size() <= 0 || A.size() != B.size() || A.size() != C.size())
        {
            throw std::invalid_argument(
                "CUDA matrix multiplication requires equal positive square matrices");
        }
        if (!cuda_backend_available())
        {
            throw std::runtime_error(
                "CUDA backend is unavailable. Build with 'make CUDA_ENABLED=1' "
                "and use a CUDA-capable NVIDIA device.");
        }
    }
} // namespace

void matmul_cuda_global_memory(const Matrix &A, const Matrix &B, Matrix &C,
                               int block_size)
{
    validate_cuda_matrices(A, B, C);
    if (block_size != 16 && block_size != 32)
    {
        throw std::invalid_argument("CUDA block size must be 16 or 32");
    }
    if (!matmul_cuda_global(A.data(), B.data(), C.data(), A.size(),
                            block_size))
    {
        throw std::runtime_error("CUDA global-memory multiplication did not complete");
    }
}

void matmul_cuda_shared_memory_tiling(const Matrix &A, const Matrix &B,
                                      Matrix &C, int tile_size)
{
    validate_cuda_matrices(A, B, C);
    if (tile_size != 16 && tile_size != 32)
    {
        throw std::invalid_argument("CUDA tile size must be 16 or 32");
    }
    if (!matmul_cuda_shared(A.data(), B.data(), C.data(), A.size(), tile_size))
    {
        throw std::runtime_error("CUDA shared-memory multiplication did not complete");
    }
}

void run_algorithm(AlgorithmType type, const Matrix &A, const Matrix &B, Matrix &C,
                   int num_threads, int bs_l3, int bs_l2, int bs_l1,
                   int cuda_tile)
{
    switch (type)
    {
    case AlgorithmType::SEQUENTIAL_BASELINE:
        matmul_sequential(A, B, C);
        break;
    case AlgorithmType::OMP_BASIC_PARALLEL:
        matmul_omp_basic(A, B, C, num_threads);
        break;
    case AlgorithmType::OMP_TILED_L2_L3:
        matmul_omp_tiled_l2_l3(A, B, C, num_threads, bs_l3, bs_l2, bs_l1);
        break;
    case AlgorithmType::OMP_TILED_L3_L1_BYPASS:
        matmul_omp_tiled_l3_l1_bypass(A, B, C, num_threads, bs_l3, bs_l1);
        break;
    case AlgorithmType::HETEROGENEOUS_OMP_CUDA:
        matmul_heterogeneous_omp_cuda(A, B, C, num_threads, -1.0,
                                      cuda_tile);
        break;
    case AlgorithmType::CUDA_GLOBAL_MEMORY:
        matmul_cuda_global_memory(A, B, C, cuda_tile);
        break;
    case AlgorithmType::CUDA_SHARED_MEMORY_TILING:
        matmul_cuda_shared_memory_tiling(A, B, C, cuda_tile);
        break;
    default:
        throw std::runtime_error("Unknown algorithm type");
    }
}
