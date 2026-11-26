#ifndef ALGORITHMS_H
#define ALGORITHMS_H

#include "matrix.h"
#include "common.h"

// Backend CUDA được biên dịch khi dùng: make CUDA_ENABLED=1.
bool cuda_backend_available();

// 1. Thuật toán tuần tự nguyên bản (Sequential Baseline)
// Độ phức tạp O(N^3), dùng làm mốc so sánh hệ số tăng tốc (Speedup)
void matmul_sequential(const Matrix &A, const Matrix &B, Matrix &C);

// 2. Thuật toán song song OpenMP cơ bản (Basic OpenMP Parallel)
// Phân chia theo hàng giữa các luồng nhưng chưa tối ưu Cache Tiling
void matmul_omp_basic(const Matrix &A, const Matrix &B, Matrix &C, int num_threads);

// 3. Thuật toán song song OpenMP phân cấp L2 + L3 (Tiled L2/L3 Parallel)
// - Siêu khối Tile3 kích thước BS_L3 (tối ưu nạp và tái sử dụng trên L3 Shared Cache)
// - Khối Tile2 kích thước BS_L2 (tối ưu L2 Cache của từng nhân)
// - Khối Tile1 kích thước BS_L1 (tối ưu L1 Data Cache và Register SIMD AVX2)
void matmul_omp_tiled_l2_l3(const Matrix &A, const Matrix &B, Matrix &C,
                            int num_threads,
                            int bs_l3 = 256, int bs_l2 = 64, int bs_l1 = 32);

// 4. Thuật toán song song OpenMP L3 + L1 "Bỏ qua L2" (Bypass L2 Tiled Parallel)
// - Nạp siêu khối Tile3 trực tiếp vào L3
// - OpenMP phân chia công việc (work-sharing) nạp trực tiếp dữ liệu từ L3 vào L1 Data Cache
void matmul_omp_tiled_l3_l1_bypass(const Matrix &A, const Matrix &B, Matrix &C,
                                   int num_threads,
                                   int bs_l3 = 256, int bs_l1 = 64);

// Cập nhật tên phần cứng CPU/GPU để định danh khi lưu/đọc file cấu hình hybrid_alpha.cfg
void set_heterogeneous_hardware_names(const std::string &cpu_name,
                                      const std::string &gpu_name);

// Tự động hiệu chỉnh và trả về tỷ lệ chia tải tối ưu alpha* cho GPU
// (đọc từ hybrid_alpha.cfg nếu đã có, hoặc chạy 3 bước đo đạc + tinh chỉnh rồi lưu lại).
double tune_heterogeneous_gpu_fraction(int num_threads, int cuda_tile = 16,
                                       bool verbose = false);

// Phân chia theo dải hàng cân bằng tải: GPU xử lý gpu_fraction hàng đầu,
// CPU xử lý phần còn lại bằng (num_threads - 1) luồng song song với 1 luồng quản lý GPU.
// - gpu_fraction <= 0.0: tự động dùng tỷ lệ cân bằng tải alpha* (mặc định).
// - gpu_fraction trong (0, 1): sử dụng tỷ lệ chỉ định thủ công.
void matmul_heterogeneous_omp_cuda(const Matrix &A, const Matrix &B, Matrix &C,
                                   int num_threads, double gpu_fraction = -1.0,
                                   int cuda_tile = 16);

// GPU-only CUDA kernels; tile_size must be 16 or 32.
void matmul_cuda_global_memory(const Matrix &A, const Matrix &B, Matrix &C,
                               int block_size = 16);

void matmul_cuda_shared_memory_tiling(const Matrix &A, const Matrix &B,
                                      Matrix &C, int tile_size = 16);

// Hàm điều phối chạy thuật toán theo cấu hình Record
void run_algorithm(AlgorithmType type, const Matrix &A, const Matrix &B, Matrix &C,
                   int num_threads, int bs_l3, int bs_l2, int bs_l1,
                   int cuda_tile = 16);

#endif // ALGORITHMS_H
