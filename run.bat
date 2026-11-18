@echo off
setlocal
echo ================================================================================
echo   CHUONG TRINH NHAN MA TRAN TOI UU - TU DONG BIEN DICH VA KHOI CHAY
echo ================================================================================

where nvcc >nul 2>nul
if %ERRORLEVEL% EQU 0 goto CUDA_BUILD

where g++ >nul 2>nul
if %ERRORLEVEL% EQU 0 goto GCC_BUILD

echo [CANH BAO] Khong tim thay nvcc hoac g++. Thu kiem tra file matmul_benchmark.exe co san...
if exist "matmul_benchmark.exe" goto RUN_APP
echo [LOI] Khong tim thay compiler (NVCC hoac G++) va chua co file matmul_benchmark.exe.
echo Vui long cai dat Visual Studio 2022 / CUDA Toolkit hoac MinGW-w64.
pause
exit /b 1

:CUDA_BUILD
echo [INFO] Phat hien trinh bien dich NVIDIA CUDA (nvcc).
echo [INFO] Dang thiet lap moi truong Visual Studio C++...

where cl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" (
        call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>nul
    )
)
where cl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat" (
        call "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>nul
    )
)
where cl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat" (
        call "C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>nul
    )
)
where cl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat" (
        call "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul 2>nul
    )
)

if not defined CUDA_ARCH set "CUDA_ARCH=sm_86"
echo [INFO] Dang bien dich CUDA (Arch: %CUDA_ARCH%) + OpenMP...
nvcc -arch=%CUDA_ARCH% -std=c++17 -O3 -Xcompiler /openmp:experimental -Iinclude src/main.cpp src/matrix.cpp src/algorithms.cpp src/excel_export.cpp src/cuda_backend.cu -o matmul_benchmark.exe
if %ERRORLEVEL% EQU 0 goto RUN_APP
echo [CANH BAO] Bien dich CUDA khong thanh cong, thu chuyen sang bien dich CPU qua GCC...

:GCC_BUILD
echo [INFO] Dang bien dich ban thuan CPU bang MinGW / GCC (g++)...
g++ -std=c++17 -O3 -fopenmp -mavx2 -mfma -Iinclude src/main.cpp src/matrix.cpp src/algorithms.cpp src/excel_export.cpp src/cuda_backend_stub.cpp -o matmul_benchmark.exe
if %ERRORLEVEL% EQU 0 goto RUN_APP

:RUN_APP
if exist "matmul_benchmark.exe" (
    echo [INFO] Khoi dong chuong trinh...
    echo.
    matmul_benchmark.exe %*
) else (
    echo [LOI] Khong tim thay file thuc thi matmul_benchmark.exe.
)

pause
