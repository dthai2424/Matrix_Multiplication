#ifndef CUDA_BACKEND_H
#define CUDA_BACKEND_H

#include <string>
#include <cstddef>

bool cuda_backend_available();
void cuda_backend_device_info(std::string& name, int& compute_major,
                              int& compute_minor, size_t& vram_mb,
                              int& multi_processors, int& cuda_cores,
                              std::string& cuda_version);

bool matmul_cuda_rows(const double* a, const double* b, double* c,
                      int n, int gpu_rows, int tile_size);

bool matmul_cuda_global(const double* a, const double* b, double* c, int n,
                        int block_size);
bool matmul_cuda_shared(const double* a, const double* b, double* c, int n,
                        int tile_size);

#endif
