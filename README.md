# DỰ ÁN: NHÂN MA TRẬN SONG SONG HIỆU NĂNG CAO (CPU + CUDA GPU)
## HIGH-PERFORMANCE MATRIX MULTIPLICATION (C++17 / OpenMP / AVX2 / CUDA)

> **Môi trường thực nghiệm chính**: **Google Colab (NVIDIA Tesla T4 GPU, 16 GB VRAM, Linux/Ubuntu)**.  
> Tương thích hoàn toàn với các GPU kiến trúc Pascal, Turing, Ampere (RTX 30-series, A100, L4).

---

## 📌 TÀI LIỆU HƯỚNG DẪN SỬ DỤNG CHI TIẾT

Dự án được phân tách thành 2 tài liệu hướng dẫn sử dụng chuyên biệt:

* 📖 **[HƯỚNG DẪN SỬ DỤNG DÀNH CHO USER (HUONG_DAN_SU_DUNG_CHO_USER.md)](./HUONG_DAN_SU_DUNG_CHO_USER.md)**:  
  *Dành cho người làm thực nghiệm, sinh viên, người đánh giá đề tài: Hướng dẫn chi tiết từng bước mở Google Colab, bật GPU T4, chạy benchmark 1-click, các kịch bản tùy chỉnh tham số, cách đọc hiểu kết quả, vẽ biểu đồ phân tích hiệu năng và tải file Excel/CSV về máy tính.*

* 🛠️ **[HƯỚNG DẪN SỬ DỤNG DÀNH CHO DEV (HUONG_DAN_SU_DUNG_CHO_DEV.md)](./HUONG_DAN_SU_DUNG_CHO_DEV.md)**:  
  *Dành cho lập trình viên: Hướng dẫn sử dụng hệ thống build Makefile trên Colab/Linux, cách tinh chỉnh các tham số trong mã nguồn (ngưỡng N, số luồng, tỷ lệ Hybrid), quy trình 5 bước phát triển & thêm thuật toán mới, sử dụng công cụ Profiling (`ncu`, `compute-sanitizer`) và đồng bộ Git trên Colab.*

* 📊 **[BÁO CÁO TOÀN DIỆN THỰC NGHIỆM (BAO_CAO_TOAN_DIEN_THUC_NGHIEM.md)](./BAO_CAO_TOAN_DIEN_THUC_NGHIEM.md)**:  
  *Đối chiếu cơ sở lý thuyết song song hóa SMP, phân tích điểm nghẽn bộ nhớ đệm Cache Miss, định luật Amdahl và phân tích bài toán kinh tế đám mây (FinOps).*

---

## 1. KHỞI CHẠY NHANH (QUICKSTART)

### Cách A: Chạy trên Máy tính cá nhân (Windows Local)
1. **Cách 1-Click**: Nhấp đúp chuột vào file `run.bat` trong thư mục dự án. Script sẽ tự động nhận diện compiler (NVCC hoặc GCC), biên dịch và khởi động chương trình.
2. **Cách dòng lệnh (PowerShell / CMD)**:
   ```powershell
   # Chạy bộ đo chuẩn tự động (N = 512, 1024, 2048, 4096):
   .\matmul_benchmark.exe --auto -r 3
   ```
3. Mở file `benchmark_results.xls` sinh ra ngay trong thư mục để xem bảng kết quả và biểu đồ.

---

### Cách B: Chạy trên Google Colab (Cloud Cluster với GPU T4)
Mở một Notebook mới trên **Google Colab**, chọn **Runtime $\rightarrow$ Change runtime type $\rightarrow$ T4 GPU**, sau đó chạy lần lượt các ô lệnh sau:

#### Bước 1: Tải mã nguồn và biên dịch với CUDA
```bash
!git clone https://github.com/thuy0an/Matrix_Multiplication.git
%cd Matrix_Multiplication
!make clean
!make CUDA_ENABLED=1 CUDA_ARCH=sm_75
```

#### Bước 2: Chạy bộ thực nghiệm chuẩn tự động
```bash
# Tự động quét các kích thước N = 512, 1024, 2048, 4096 (lấy trung bình 3 lần chạy):
!./matmul_benchmark --auto -r 3 -o colab_results.csv
```

#### Bước 3: Xem dữ liệu và tải báo cáo Excel về máy tính
```python
import pandas as pd
from google.colab import files

# Hiển thị kết quả dạng bảng
df = pd.read_csv('benchmark_results.csv')
display(df[['KichThuoc_N', 'SoLuong_Luong_q', 'ThuatToan', 'ThoiGian_s', 'HieuNang_GFLOPS', 'TangToc_Speedup', 'KiemDinh']])

# Tải file Excel có định dạng màu và công thức về máy
files.download('benchmark_results.xls')
files.download('benchmark_results.csv')
```

### Banner thông tin môi trường thực thi (Tự động nhận diện động)
Khi chương trình khởi chạy, toàn bộ cấu hình hệ điều hành, trình biên dịch, dung lượng RAM, cấu trúc bộ nhớ đệm CPU và GPU CUDA sẽ được nhận diện và hiển thị trực quan:

```text
================================================================================
                       CHUONG TRINH NHAN MA TRAN TOI UU                         
================================================================================
 [1] HE DIEU HANH & MOI TRUONG DICH:
     - He dieu hanh        : Windows 10 Home Single Language (64-bit) / Ubuntu Linux
     - Trinh bien dich     : NVCC 13.5 / MSVC 1944 (OpenMP 2019) / GCC
     - Bo nho he thong RAM : 15.25 GB Tong cong (Kha dung: 2.71 GB)

 [2] CAU HINH PHAN CUNG CPU:
     - Model CPU           : AMD Ryzen 7 6800H with Radeon Graphics / Intel Xeon
     - Nhan vat ly / Logic : 8 Nhan vat ly | 16 Luong logic (OpenMP Max: 16)
     - Bo nho dem L1 Data  : 32 KB / core
     - Bo nho dem L2       : 512 KB / core (4 MB tong cong)
     - Bo nho dem L3       : 16 MB (Shared L3 Cache)

 [3] CAU HINH PHAN CUNG GPU (CUDA):
     - Thiet bi GPU        : NVIDIA GeForce RTX 3050 Ti Laptop GPU / Tesla T4
     - Dung luong VRAM     : 4095 MB (4.00 GB) / 15360 MB (15.00 GB)
     - Kien truc Compute   : SM 8.6 (20 Streaming Multiprocessors) / SM 7.5
     - Phien ban CUDA      : Runtime 13.3 (Driver 13.3)
================================================================================
```

---

## 2. DANH MỤC THUẬT TOÁN ĐÃ CÀI ĐẶT

Hệ thống hiện thực hóa và so sánh đối đầu **3 nhóm thuật toán chính**:

1. **Nhóm thuật toán CPU (Đa nhân OpenMP & Tối ưu Cache)**:
   - `1. Tuan tu (Baseline)`: Duyệt tuần tự 3 vòng lặp $O(N^3)$, làm mốc đối chứng (Ground Truth).
   - `2. Song song OpenMP Co ban`: Song song hóa phân chia hàng ma trận nhưng chưa tối ưu Cache Miss.
   - `3. Song song Tiled L2+L3`: Chia khối đa tầng: Siêu khối Tile3 (L3 Cache), Khối con Tile2 (L2 Cache) và Vi khối Tile1 (L1 Cache + Vector hóa AVX2).
   - `4. Song song Bypass L2`: Bơm trực tiếp dữ liệu từ L3 xuống L1 Data Cache của từng nhân.
2. **Nhóm thuật toán GPU (NVIDIA CUDA)**:
   - `CUDA Global Memory`: Mỗi thread tính một phần tử $C$, đọc trực tiếp từ VRAM.
   - `CUDA Shared Memory Tiling`: Chia khối kích thước 16x16 hoặc 32x32 nạp vào Shared Memory, đồng bộ hóa bằng `__syncthreads()`.
3. **Nhóm thuật toán Dị thể (Heterogeneous CPU + GPU Co-processing)**:
   - `5. Ket hop CPU + CUDA GPU`: Đồng thời chia 80% số hàng cho GPU CUDA và 20% số hàng cho CPU OpenMP thông qua `omp parallel sections`.

---

## 3. CƠ CHẾ TỰ ĐỘNG ĐIỀU PHỐI KÍCH THƯỚC MA TRẬN ($N$)

Để giải quyết bài toán thời gian khi kích thước ma trận tăng lên quy mô lớn, chương trình áp dụng quy tắc thích ứng:

- **Khi $N < 2048$ ($N = 512, 1024$)**:
  - Chạy đầy đủ thuật toán Tuần tự Baseline để đo lường mốc cơ sở ($G_{\text{seq}} \approx 6.2\text{ GFLOPS}$).
  - Quét qua toàn bộ các mức luồng CPU: `1, 2, 4, 8, 16` luồng.
- **Khi $N \ge 2048$ ($N = 2048, 4096$)**:
  - **Tự động bỏ qua thuật toán Tuần tự Baseline**: Tránh lãng phí hàng chục phút chờ đợi phép tính $O(N^3)$. Thời gian $t_{\text{seq}}$ được ngoại suy lý thuyết để giữ cột Speedup.
  - **Tự động lọc luồng CPU**: Chỉ đo ở **8 Cores** (nhân vật lý) và **16 Threads** (luồng logic SMT). Bỏ qua các mức luồng nhỏ $1, 2, 4$.
  - **Tập trung đo 3 trụ cột song song**: CPU Parallel, GPU Parallel và CPU+GPU Hybrid.
  - **Kiểm định chuẩn xác**: Sinh ma trận đối chứng $C_{\text{ref}}$ bằng CPU Tiled 16 luồng để kiểm định sai số Frobenius norm (`DAT / PASSED`).

---

## 4. TÓM TẮT DỮ LIỆU ĐO ĐẠC THỰC NGHIỆM ĐIỂN HÌNH

### Bảng so sánh hiệu năng thực tế tại $N = 2048$ và $N = 4096$:

| Kích thước $N$ | Thuật toán | Cấu hình thực thi | Thời gian ($s$) | Tốc độ (GFLOPS) | Tăng tốc (Speedup) | Kiểm định |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| **$N = 2048$** | OpenMP Cơ bản | 16 Threads | 1.442 s | 11.91 GFLOPS | 1.92x | DAT (OK) |
| *(96 MB)* | OpenMP Tiled L2+L3 | 16 Threads | 2.012 s | 8.54 GFLOPS | 1.38x | DAT (OK) |
| | **Kết hợp CPU + CUDA GPU** | **16 Threads + GPU** | **0.380 s** | **45.11 GFLOPS** | **7.28x** | DAT (OK) |
| | **CUDA Global Memory** | **GPU (VRAM)** | **0.137 s** | **124.88 GFLOPS** | **20.14x** | DAT (OK) |
| | **CUDA Shared Memory Tiling** | **GPU (Shared Memory)** | **0.136 s** | **126.13 GFLOPS** | **20.34x** | DAT (OK) |
| **$N = 4096$** | OpenMP Cơ bản | 16 Threads | 12.409 s | 11.08 GFLOPS | 1.78x | DAT (OK) |
| *(384 MB)* | OpenMP Tiled L2+L3 | 16 Threads | 14.391 s | 9.55 GFLOPS | 1.54x | DAT (OK) |
| | **Kết hợp CPU + CUDA GPU** | **16 Threads + GPU** | **3.432 s** | **40.05 GFLOPS** | **6.45x** | DAT (OK) |
| | **CUDA Global Memory** | **GPU (VRAM)** | **1.036 s** | **132.66 GFLOPS** | **21.35x** | DAT (OK) |
| | **CUDA Shared Memory Tiling** | **GPU (Shared Memory)** | **1.001 s** | **137.27 GFLOPS** | **22.14x** | DAT (OK) |

---

## 5. TẬP TIN XUẤT KẾT QUẢ

- **`benchmark_results.xls`**: Bảng tính Microsoft Excel định dạng XML Spreadsheet 2003 có màu sắc, đường viền, phân chia nhiều sheet và công thức thống kê tự động.
- **`benchmark_results.csv`**: File định dạng CSV tiêu chuẩn UTF-8, sẵn sàng để import vào Python (`pandas`), MATLAB hoặc R để vẽ đồ thị đường cong hiệu năng.
