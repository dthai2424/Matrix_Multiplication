# Hướng dẫn chạy MatMul Bench Web UI qua Google Colab Pro Tunneling

Thư mục này gồm 3 file gọn nhẹ để gắn Web UI trực tiếp vào repo `thuy0an/Matrix_Multiplication`:
- `index.html`: Giao diện Web tự chứa (không phụ thuộc CDN ngoài), có biểu đồ GFLOPS / Thời gian / Speedup / Thread Scaling / **Cân bằng Hybrid ($\alpha^*$)** và bảng đối chiếu.
- `server.py`: Backend FastAPI gọi trực tiếp `./matmul_benchmark`, stream log & kết quả chấm điểm CPU/GPU realtime qua SSE, hỗ trợ tải `.xls` / `.csv`.
- `colab_tunnel.py`: Script khởi động FastAPI + mở link HTTPS công khai bằng Cloudflare Tunnel (`trycloudflare.com`, không cần tài khoản hay authtoken).

---

## Cách chạy trên Google Colab Pro (3 cell)

### Cell 1 — Clone repo & tự nhận kiến trúc GPU để biên dịch CUDA (T4 / L4 / A100)
```bash
!git clone https://github.com/dthai2424/Matrix_Multiplication.git
%cd Matrix_Multiplication

# Tự đọc Compute Capability của GPU Colab Pro (T4=sm_75, A100=sm_80, L4=sm_89)
!ARCH="sm_$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n1 | tr -d '.')" && \
 echo "Building for CUDA_ARCH=$ARCH" && \
 make clean && make CUDA_ENABLED=1 CUDA_ARCH=$ARCH
```

### Cell 2 — Upload thư mục `web_ui` (hoặc copy từ Drive/GitHub) và cài FastAPI
Nếu bạn đẩy thư mục `web_ui/` vào repo (hoặc upload 3 file `index.html`, `server.py`, `colab_tunnel.py` vào `/content/Matrix_Multiplication/web_ui/`):
```bash
!pip install -q fastapi uvicorn
```

### Cell 3 — Chạy Web UI & mở link public Cloudflare Tunnel
```bash
!MATMUL_REPO_DIR=/content/Matrix_Multiplication python web_ui/colab_tunnel.py
```

Sau vài giây, Colab sẽ in ra đường link dạng:
```text
====================================================================
  WEB UI ĐÃ SẴN SÀNG:  https://xxxxx-yyyyy.trycloudflare.com
====================================================================
```
Mở link đó trên máy tính hoặc điện thoại:
1. Góc trên thanh điều hướng sẽ hiện **chấm xanh** cùng tên GPU/CPU thật của máy Colab Pro.
2. Chọn kích thước `N`, số luồng `Threads`, `CUDA Tile`, tích **Đo lại điểm CPU/GPU mới** $\rightarrow$ bấm **Chạy thực nghiệm**.
3. Log chạy từ `./matmul_benchmark` sẽ nhảy realtime, sau đó 4 biểu đồ + tab **Cân bằng Hybrid ($\alpha^*$)** + nút **Tải Excel (.xls)** sẽ tự cập nhật.
