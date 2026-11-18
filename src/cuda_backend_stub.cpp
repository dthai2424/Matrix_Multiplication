#include "cuda_backend.h"

bool cuda_backend_available() {
    return false;
}

void cuda_backend_device_info(std::string&, int& compute_major,
                              int& compute_minor, size_t& vram_mb,
                              int& multi_processors, std::string&) {
    compute_major = 0;
    compute_minor = 0;
    vram_mb = 0;
    multi_processors = 0;
}

bool matmul_cuda_rows(const double*, const double*, double*, int, int, int) {
    return false;
}

bool matmul_cuda_global(const double*, const double*, double*, int, int) {
    return false;
}

bool matmul_cuda_shared(const double*, const double*, double*, int, int) {
    return false;
}
