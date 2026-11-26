#include "excel_export.h"
#include <fstream>
#include <sstream>
#include <iomanip>
#include <iostream>
#include <map>

namespace {
    std::string escape_xml(const std::string& data) {
        std::string buffer;
        buffer.reserve(data.size() * 1.1);
        for (char c : data) {
            switch (c) {
                case '&':  buffer.append("&amp;");       break;
                case '\"': buffer.append("&quot;");      break;
                case '\'': buffer.append("&apos;");      break;
                case '<':  buffer.append("&lt;");        break;
                case '>':  buffer.append("&gt;");        break;
                default:   buffer.push_back(c);          break;
            }
        }
        return buffer;
    }

    std::string escape_json(const std::string& data) {
        std::string buffer;
        buffer.reserve(data.size() + 8);
        for (char c : data) {
            switch (c) {
                case '\\': buffer.append("\\\\"); break;
                case '\"': buffer.append("\\\""); break;
                case '\n': buffer.append("\\n"); break;
                case '\r': buffer.append("\\r"); break;
                case '\t': buffer.append("\\t"); break;
                case '<':  buffer.append("\\u003c"); break;
                case '>':  buffer.append("\\u003e"); break;
                case '&':  buffer.append("\\u0026"); break;
                default:   buffer.push_back(c); break;
            }
        }
        return buffer;
    }

    std::string algo_key_str(AlgorithmType t) {
        switch (t) {
            case AlgorithmType::SEQUENTIAL_BASELINE:        return "seq";
            case AlgorithmType::OMP_BASIC_PARALLEL:         return "omp_basic";
            case AlgorithmType::OMP_TILED_L2_L3:            return "omp_l2_l3";
            case AlgorithmType::OMP_TILED_L3_L1_BYPASS:     return "omp_bypass";
            case AlgorithmType::HETEROGENEOUS_OMP_CUDA:     return "hybrid";
            case AlgorithmType::CUDA_GLOBAL_MEMORY:         return "cuda_global";
            case AlgorithmType::CUDA_SHARED_MEMORY_TILING:  return "cuda_shared";
            default:                                        return "other";
        }
    }
}

bool ExcelExporter::exportToExcel(const std::string& filename, 
                                 const std::vector<BenchmarkRecord>& records,
                                 const HardwareInfo& hw) {
    std::ofstream out(filename);
    if (!out.is_open()) {
        std::cerr << "[Lỗi] Không thể tạo file Excel: " << filename << std::endl;
        return false;
    }

    out << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
    out << "<?mso-application progid=\"Excel.Sheet\"?>\n";
    out << "<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\"\n";
    out << " xmlns:o=\"urn:schemas-microsoft-com:office:office\"\n";
    out << " xmlns:x=\"urn:schemas-microsoft-com:office:excel\"\n";
    out << " xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\"\n";
    out << " xmlns:html=\"http://www.w3.org/TR/REC-html40\">\n";

    // 1. STYLES
    out << " <Styles>\n";
    out << "  <Style ss:ID=\"Default\" ss:Name=\"Normal\">\n";
    out << "   <Alignment ss:Vertical=\"Center\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"10\" ss:Color=\"#000000\"/>\n";
    out << "  </Style>\n";

    // Title Style
    out << "  <Style ss:ID=\"TitleStyle\">\n";
    out << "   <Alignment ss:Horizontal=\"Left\" ss:Vertical=\"Center\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"14\" ss:Bold=\"1\" ss:Color=\"#1F4E78\"/>\n";
    out << "  </Style>\n";

    // Subtitle Style
    out << "  <Style ss:ID=\"SubTitleStyle\">\n";
    out << "   <Alignment ss:Horizontal=\"Left\" ss:Vertical=\"Center\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"10\" ss:Italic=\"1\" ss:Color=\"#595959\"/>\n";
    out << "  </Style>\n";

    // Header Style
    out << "  <Style ss:ID=\"HeaderStyle\">\n";
    out << "   <Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\" ss:WrapText=\"1\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#002060\"/>\n";
    out << "    <Border ss:Position=\"Top\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#002060\"/>\n";
    out << "    <Border ss:Position=\"Left\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#002060\"/>\n";
    out << "    <Border ss:Position=\"Right\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#002060\"/>\n";
    out << "   </Borders>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"10\" ss:Bold=\"1\" ss:Color=\"#FFFFFF\"/>\n";
    out << "   <Interior ss:Color=\"#1F4E78\" ss:Pattern=\"Solid\"/>\n";
    out << "  </Style>\n";

    // Data Row Styles
    out << "  <Style ss:ID=\"DataText\">\n";
    out << "   <Alignment ss:Horizontal=\"Left\" ss:Vertical=\"Center\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataCenter\">\n";
    out << "   <Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataInteger\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"#,##0\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataTimeSec\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"0.000000\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataTimeMs\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"#,##0.00\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataGflops\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"#,##0.00\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"10\" ss:Bold=\"1\" ss:Color=\"#107C41\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataSpeedup\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"0.00\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"10\" ss:Bold=\"1\" ss:Color=\"#C00000\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataEfficiency\">\n";
    out << "   <Alignment ss:Horizontal=\"Right\" ss:Vertical=\"Center\"/>\n";
    out << "   <NumberFormat ss:Format=\"0.0%\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << "  <Style ss:ID=\"DataPassed\">\n";
    out << "   <Alignment ss:Horizontal=\"Center\" ss:Vertical=\"Center\"/>\n";
    out << "   <Font ss:FontName=\"Segoe UI\" ss:Size=\"9\" ss:Bold=\"1\" ss:Color=\"#0E6251\"/>\n";
    out << "   <Interior ss:Color=\"#D4EFDF\" ss:Pattern=\"Solid\"/>\n";
    out << "   <Borders>\n";
    out << "    <Border ss:Position=\"Bottom\" ss:LineStyle=\"Continuous\" ss:Weight=\"1\" ss:Color=\"#D9D9D9\"/>\n";
    out << "   </Borders>\n";
    out << "  </Style>\n";

    out << " </Styles>\n";

    // 2. WORKSHEET 1: TỔNG HỢP KẾT QUẢ THỰC NGHIỆM
    out << " <Worksheet ss:Name=\"Tong_Hop_Benchmark\">\n";
    out << "  <Table ss:DefaultRowHeight=\"20\">\n";
    out << "   <Column ss:Width=\"45\"/>\n";   // STT
    out << "   <Column ss:Width=\"90\"/>\n";   // Ma trận N
    out << "   <Column ss:Width=\"90\"/>\n";   // Số luồng
    out << "   <Column ss:Width=\"240\"/>\n";  // Thuật toán
    out << "   <Column ss:Width=\"80\"/>\n";   // L3 Tile
    out << "   <Column ss:Width=\"80\"/>\n";   // L2 Tile
    out << "   <Column ss:Width=\"80\"/>\n";   // L1 Tile
    out << "   <Column ss:Width=\"90\"/>\n";   // CUDA block/tile
    out << "   <Column ss:Width=\"100\"/>\n";  // Thời gian (s)
    out << "   <Column ss:Width=\"100\"/>\n";  // Thời gian (ms)
    out << "   <Column ss:Width=\"120\"/>\n";  // Tổng phép tính FLOP
    out << "   <Column ss:Width=\"100\"/>\n";  // GFLOPS
    out << "   <Column ss:Width=\"100\"/>\n";  // Tăng tốc Speedup
    out << "   <Column ss:Width=\"100\"/>\n";  // Hiệu suất Efficiency
    out << "   <Column ss:Width=\"110\"/>\n";  // Amdahl lý thuyết
    out << "   <Column ss:Width=\"110\"/>\n";  // Tỉ lệ giảm trượt Cache
    out << "   <Column ss:Width=\"100\"/>\n";  // Sai số cực đại
    out << "   <Column ss:Width=\"90\"/>\n";   // Kiểm định
    out << "   <Column ss:Width=\"140\"/>\n";  // Thời điểm chạy

    // Tiêu đề báo cáo
    out << "   <Row ss:Height=\"28\">\n";
    out << "    <Cell ss:MergeAcross=\"18\" ss:StyleID=\"TitleStyle\"><Data ss:Type=\"String\">BÁO CÁO THỰC NGHIỆM: NHÂN MA TRẬN SONG SONG CPU VÀ CUDA GPU</Data></Cell>\n";
    out << "   </Row>\n";
    out << "   <Row ss:Height=\"18\">\n";
    out << "    <Cell ss:MergeAcross=\"18\" ss:StyleID=\"SubTitleStyle\"><Data ss:Type=\"String\">CPU: "
        << escape_xml(hw.cpu_name) << " | GPU: " << escape_xml(hw.gpu_name)
        << " (Compute " << (hw.gpu_compute_major > 0
                                ? std::to_string(hw.gpu_compute_major) + "." +
                                      std::to_string(hw.gpu_compute_minor)
                                : "N/A")
        << ") | " << hw.physical_cores << " Cores / " << hw.logical_processors
        << " Threads | L2: " << hw.l2_cache_kb << "KB x " << hw.physical_cores << " | L3: " << (hw.l3_cache_kb / 1024) 
        << "MB Shared | Trình biên dịch: " << escape_xml(hw.compiler_info) << "</Data></Cell>\n";
    out << "   </Row>\n";
    out << "   <Row ss:Height=\"10\"/>\n"; // Dòng trống

    // Dòng Header
    out << "   <Row ss:Height=\"26\">\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">STT</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Kích thước N</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Số luồng (q)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thuật toán</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Khối L3 (Tile3)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Khối L2 (Tile2)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Khối L1 (Tile1)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">CUDA Block/Tile</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thời gian (s)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thời gian (ms)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Tổng FLOP (2*N³)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">GFLOPS</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Tăng tốc (Speedup)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Hiệu suất (%)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Amdahl lý thuyết</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Hệ số giảm Cache Miss</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Sai số cực đại</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Kiểm định</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thời điểm</Data></Cell>\n";
    out << "   </Row>\n";

    // Các dòng dữ liệu
    for (const auto& r : records) {
        out << "   <Row ss:Height=\"20\">\n";
        out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.id << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << r.N << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.threads << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(r.algo_name) << "</Data></Cell>\n";
        
        if (r.l3_tile > 0) out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.l3_tile << "</Data></Cell>\n";
        else out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"String\">-</Data></Cell>\n";

        if (r.l2_tile > 0) out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.l2_tile << "</Data></Cell>\n";
        else out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"String\">-</Data></Cell>\n";

        if (r.l1_tile > 0) out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.l1_tile << "</Data></Cell>\n";
        else out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"String\">-</Data></Cell>\n";

        if (r.cuda_tile > 0) out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.cuda_tile << "</Data></Cell>\n";
        else out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"String\">-</Data></Cell>\n";

        out << "    <Cell ss:StyleID=\"DataTimeSec\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(6) << r.time_sec << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataTimeMs\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.time_ms << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << r.flops << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataGflops\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.gflops << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataSpeedup\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.speedup << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataEfficiency\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(4) << (r.efficiency / 100.0) << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataSpeedup\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.amdahl_speedup << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataSpeedup\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(1) << r.estimated_cache_miss_reduction << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataTimeSec\"><Data ss:Type=\"Number\">" << std::scientific << std::setprecision(2) << r.max_error << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataPassed\"><Data ss:Type=\"String\">" << (r.verified ? "ĐẠT" : "KHÔNG ĐẠT") << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"String\">" << escape_xml(r.timestamp) << "</Data></Cell>\n";
        out << "   </Row>\n";
    }

    out << "  </Table>\n";
    out << " </Worksheet>\n";

    // 3. WORKSHEET 2: SO SÁNH THUẬT TOÁN (ALGORITHM COMPARISON)
    out << " <Worksheet ss:Name=\"So_Sanh_Thuat_Toan\">\n";
    out << "  <Table ss:DefaultRowHeight=\"20\">\n";
    out << "   <Column ss:Width=\"100\"/>\n";
    out << "   <Column ss:Width=\"220\"/>\n";
    out << "   <Column ss:Width=\"90\"/>\n";
    out << "   <Column ss:Width=\"110\"/>\n";
    out << "   <Column ss:Width=\"110\"/>\n";
    out << "   <Column ss:Width=\"110\"/>\n";
    out << "   <Column ss:Width=\"110\"/>\n";
    
    out << "   <Row ss:Height=\"26\">\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Kích thước N</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thuật toán</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Số luồng</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thời gian (s)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">GFLOPS</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Tăng tốc (Speedup)</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Hiệu suất (%)</Data></Cell>\n";
    out << "   </Row>\n";

    for (const auto& r : records) {
        out << "   <Row ss:Height=\"20\">\n";
        out << "    <Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << r.N << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(r.algo_name) << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataCenter\"><Data ss:Type=\"Number\">" << r.threads << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataTimeSec\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(6) << r.time_sec << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataGflops\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.gflops << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataSpeedup\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(2) << r.speedup << "</Data></Cell>\n";
        out << "    <Cell ss:StyleID=\"DataEfficiency\"><Data ss:Type=\"Number\">" << std::fixed << std::setprecision(4) << (r.efficiency / 100.0) << "</Data></Cell>\n";
        out << "   </Row>\n";
    }
    out << "  </Table>\n";
    out << " </Worksheet>\n";

    // 4. WORKSHEET 3: THÔNG TIN PHẦN CỨNG & LÝ THUYẾT CACHE
    out << " <Worksheet ss:Name=\"Thong_So_CPU_CUDA\">\n";
    out << "  <Table ss:DefaultRowHeight=\"20\">\n";
    out << "   <Column ss:Width=\"220\"/>\n";
    out << "   <Column ss:Width=\"350\"/>\n";
    out << "   <Row ss:Height=\"26\">\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Thông số hệ thống & phần cứng</Data></Cell>\n";
    out << "    <Cell ss:StyleID=\"HeaderStyle\"><Data ss:Type=\"String\">Giá trị chi tiết</Data></Cell>\n";
    out << "   </Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Hệ điều hành (OS)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(hw.os_name) << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Trình biên dịch</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(hw.compiler_info) << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Bộ nhớ hệ thống (RAM)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << std::fixed << std::setprecision(2) << hw.total_ram_gb << " GB (Khả dụng: " << hw.free_ram_gb << " GB)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Bộ vi xử lý (CPU)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(hw.cpu_name) << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Số nhân vật lý (Physical Cores)</Data></Cell><Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << hw.physical_cores << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Số luồng logic (Logical Processors)</Data></Cell><Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << hw.logical_processors << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">L1 Data Cache (mỗi nhân)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << hw.l1d_cache_kb << " KB (Khối Tile1 khuyến nghị: 32 - 64)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">L2 Cache (mỗi nhân)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << hw.l2_cache_kb << " KB (Khối Tile2 khuyến nghị: 64 - 128)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">L3 Cache (chia sẻ dùng chung)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << (hw.l3_cache_kb / 1024) << " MB (Khối Tile3 khuyến nghị: 256 - 512)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Thiết bị CUDA (GPU)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(hw.gpu_name) << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Dung lượng VRAM GPU</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << hw.gpu_vram_mb << " MB (" << std::fixed << std::setprecision(2) << (static_cast<double>(hw.gpu_vram_mb) / 1024.0) << " GB)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Compute capability</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << (hw.gpu_compute_major > 0 ? std::to_string(hw.gpu_compute_major) + "." + std::to_string(hw.gpu_compute_minor) : "N/A") << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Số Multiprocessors (SMs)</Data></Cell><Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << hw.gpu_multiprocessors << "</Data></Cell></Row>\n";
    if (hw.gpu_cuda_cores > 0)
    {
        out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Tổng số nhân CUDA (CUDA Cores)</Data></Cell><Cell ss:StyleID=\"DataInteger\"><Data ss:Type=\"Number\">" << hw.gpu_cuda_cores << "</Data></Cell></Row>\n";
    }
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Phiên bản CUDA</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">" << escape_xml(hw.cuda_version.empty() ? "N/A" : hw.cuda_version) << "</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Mô hình bộ nhớ</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">SMP Shared Memory (Fork-Join OpenMP)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Tập lệnh vector hóa</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">AVX2 + FMA3 (256-bit SIMD registers)</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Định luật Amdahl (Mục 3.5)</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Speedup = 1 / ( (1 - p) + p / q )</Data></Cell></Row>\n";
    out << "   <Row><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">Tài liệu đối chiếu</Data></Cell><Cell ss:StyleID=\"DataText\"><Data ss:Type=\"String\">An - CPU song song hóa.docx (Kelefouras et al., 2016)</Data></Cell></Row>\n";
    out << "  </Table>\n";
    out << " </Worksheet>\n";

    out << "</Workbook>\n";
    out.close();
    return true;
}
bool ExcelExporter::exportToCSV(const std::string& filename,
                               const std::vector<BenchmarkRecord>& records,
                               const HardwareInfo& /*hw*/) {
    std::ofstream out(filename);
    if (!out.is_open()) {
        std::cerr << "[Lỗi] Không thể tạo file CSV: " << filename << std::endl;
        return false;
    }

    // Header UTF-8 BOM để Excel hiển thị đúng tiếng Việt
    out << "\xEF\xBB\xBF";

    // Tiêu đề cột
    out << "STT,KichThuoc_N,SoLuong_Luong_q,ThuatToan,Khoi_L3_Tile,Khoi_L2_Tile,Khoi_L1_Tile,CUDA_Block_Tile,"
        << "ThoiGian_s,ThoiGian_ms,Tong_FLOP,HieuNang_GFLOPS,TangToc_Speedup,HieuSuat_Efficiency_Pct,"
        << "Amdahl_LyThuyet,Giam_Cache_Miss_Ratio,SaiSo_CucDai,KiemDinh,ThoiDiem\n";

    for (const auto& r : records) {
        out << r.id << ","
            << r.N << ","
            << r.threads << ","
            << "\"" << r.algo_name << "\","
            << r.l3_tile << ","
            << r.l2_tile << ","
            << r.l1_tile << ","
            << r.cuda_tile << ","
            << std::fixed << std::setprecision(6) << r.time_sec << ","
            << std::fixed << std::setprecision(2) << r.time_ms << ","
            << r.flops << ","
            << std::fixed << std::setprecision(2) << r.gflops << ","
            << std::fixed << std::setprecision(2) << r.speedup << ","
            << std::fixed << std::setprecision(2) << r.efficiency << ","
            << std::fixed << std::setprecision(2) << r.amdahl_speedup << ","
            << std::fixed << std::setprecision(1) << r.estimated_cache_miss_reduction << ","
            << std::scientific << std::setprecision(2) << r.max_error << ","
            << (r.verified ? "PASSED" : "FAILED") << ","
            << "\"" << r.timestamp << "\"\n";
    }

    out.close();
    return true;
}

bool ExcelExporter::exportToHTMLChart(const std::string& filename,
                                      const std::vector<BenchmarkRecord>& records,
                                      const HardwareInfo& hw) {
    if (records.empty()) {
        return false;
    }
    std::ofstream out(filename);
    if (!out.is_open()) {
        std::cerr << "[Lỗi] Không thể tạo file biểu đồ HTML: " << filename << std::endl;
        return false;
    }

    out << R"HTML(<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Báo Cáo Biểu Đồ Thực Nghiệm - Nhân Ma Trận Song Song</title>
<style>
  :root {
    --bg: #f4f6fa; --card: #ffffff; --border: #e2e8f0;
    --text: #1e293b; --muted: #64748b; --primary: #2563eb;
    --accent: #0f766e; --good: #16a34a; --warn: #d97706;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; font-family: "Segoe UI", Roboto, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
  }
  .container { max-width: 1280px; margin: 0 auto; }
  .header {
    background: linear-gradient(135deg, #1e3a8a, #2563eb); color: #fff;
    padding: 22px 26px; border-radius: 14px; margin-bottom: 20px;
    box-shadow: 0 6px 20px rgba(37,99,235,0.18);
  }
  .header h1 { margin: 0 0 6px 0; font-size: 22px; letter-spacing: 0.3px; }
  .header .sub { opacity: 0.92; font-size: 13.5px; }
  .hw-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px; margin-top: 14px;
  }
  .hw-item {
    background: rgba(255,255,255,0.13); border: 1px solid rgba(255,255,255,0.22);
    padding: 10px 13px; border-radius: 9px; font-size: 12.5px;
  }
  .hw-item b { display: block; font-size: 11px; text-transform: uppercase; opacity: 0.8; margin-bottom: 2px; }
  .kpi-row {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px; margin-bottom: 20px;
  }
  .kpi {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 18px; box-shadow: 0 2px 6px rgba(15,23,42,0.04);
  }
  .kpi .lbl { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; }
  .kpi .val { font-size: 24px; font-weight: 700; color: var(--primary); margin: 4px 0 2px; }
  .kpi .desc { font-size: 12.5px; color: var(--text); }
  .charts-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(560px, 1fr));
    gap: 18px; margin-bottom: 22px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; box-shadow: 0 2px 8px rgba(15,23,42,0.05);
    position: relative;
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap; margin-bottom: 10px;
  }
  .card-head h2 { margin: 0; font-size: 16px; color: #0f172a; }
  .controls { display: flex; gap: 8px; align-items: center; }
  button, select {
    border: 1px solid #cbd5e1; background: #f8fafc; color: #0f172a;
    padding: 5px 10px; border-radius: 7px; font-size: 12.5px; cursor: pointer;
    font-weight: 600;
  }
  button:hover { background: #e2e8f0; }
  button.primary { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
  button.primary:hover { background: #dbeafe; }
  canvas { width: 100%; height: 340px; display: block; border-radius: 6px; }
  .legend {
    display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 8px;
    font-size: 12px; color: #334155;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  table {
    width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px;
  }
  th, td { padding: 9px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  th { background: #f1f5f9; font-weight: 700; color: #0f172a; }
  tr:hover td { background: #f8fafc; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11.5px; font-weight: 700; background: #dcfce7; color: #166534;
  }
  .pros-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 14px; margin-top: 14px;
  }
  .pro-card {
    border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px;
    padding: 12px 14px; background: #fafcff; font-size: 13px;
  }
  .pro-card h3 { margin: 0 0 6px; font-size: 14.5px; }
  .pro-card ul { margin: 4px 0 0 18px; padding: 0; }
  .pro-card li { margin-bottom: 3px; }
  #tooltip {
    position: fixed; pointer-events: none; display: none; z-index: 99;
    background: rgba(15,23,42,0.94); color: #fff; padding: 8px 11px;
    border-radius: 8px; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.22);
    max-width: 280px;
  }
  @media (max-width: 680px) {
    .charts-grid { grid-template-columns: 1fr; }
    body { padding: 12px; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>BÁO CÁO BIỂU ĐỒ THỰC NGHIỆM NHÂN MA TRẬN SONG SONG</h1>
    <div class="sub">So sánh hiệu năng, tốc độ, tăng tốc (Speedup) và ưu/nhược điểm giữa các phương pháp trên các mốc kích thước N</div>
    <div class="hw-grid" id="hwGrid"></div>
  </div>
  <div class="kpi-row" id="kpiRow"></div>
  <div class="charts-grid">
    <div class="card">
      <div class="card-head">
        <h2>1. Hiệu năng tính toán (GFLOPS) theo kích thước N</h2>
        <div class="controls">
          <button class="primary" onclick="downloadChart('cGflops','bieu_do_gflops.png')">Tải ảnh PNG</button>
        </div>
      </div>
      <canvas id="cGflops"></canvas>
      <div class="legend" id="leg1"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>2. Thời gian thực thi (giây) theo kích thước N</h2>
        <div class="controls">
          <button id="btnLog" onclick="toggleLog()">Thang Log: BẬT</button>
          <button class="primary" onclick="downloadChart('cTime','bieu_do_thoi_gian.png')">Tải ảnh PNG</button>
        </div>
      </div>
      <canvas id="cTime"></canvas>
      <div class="legend" id="leg2"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>3. Hệ số tăng tốc (Speedup) theo kích thước N</h2>
        <div class="controls">
          <button class="primary" onclick="downloadChart('cSpeedup','bieu_do_speedup.png')">Tải ảnh PNG</button>
        </div>
      </div>
      <canvas id="cSpeedup"></canvas>
      <div class="legend" id="leg3"></div>
    </div>
    <div class="card">
      <div class="card-head">
        <h2>4. Mở rộng theo số luồng CPU (Thread Scaling)</h2>
        <div class="controls">
          <select id="nScaleSelect" onchange="drawThreadScaling()"></select>
          <button class="primary" onclick="downloadChart('cThreads','bieu_do_thread_scaling.png')">Tải ảnh PNG</button>
        </div>
      </div>
      <canvas id="cThreads"></canvas>
      <div class="legend" id="leg4"></div>
    </div>
  </div>
  <div class="card" style="margin-bottom:18px;">
    <div class="card-head"><h2>5. Bảng đối chiếu phương pháp tối ưu qua từng mốc N</h2></div>
    <div id="milestoneTable"></div>
  </div>
  <div class="card">
    <div class="card-head"><h2>6. Đánh giá Ưu điểm &amp; Nhược điểm từng phương pháp</h2></div>
    <div class="pros-grid" id="prosGrid"></div>
  </div>
</div>
<div id="tooltip"></div>
<script>
)HTML";

    // Xuất dữ liệu phần cứng và kết quả thực nghiệm dạng JSON nhúng trực tiếp
    out << "const HW_INFO = {\n"
        << "  os: \"" << escape_json(hw.os_name) << "\",\n"
        << "  compiler: \"" << escape_json(hw.compiler_info) << "\",\n"
        << "  ram_gb: " << std::fixed << std::setprecision(2) << hw.total_ram_gb << ",\n"
        << "  cpu: \"" << escape_json(hw.cpu_name) << "\",\n"
        << "  cores: " << hw.physical_cores << ",\n"
        << "  logical: " << hw.logical_processors << ",\n"
        << "  l1: " << hw.l1d_cache_kb << ",\n"
        << "  l2: " << hw.l2_cache_kb << ",\n"
        << "  l3: " << (hw.l3_cache_kb / 1024) << ",\n"
        << "  gpu: \"" << escape_json(hw.gpu_name) << "\",\n"
        << "  vram_mb: " << hw.gpu_vram_mb << ",\n"
        << "  cuda_cores: " << hw.gpu_cuda_cores << ",\n"
        << "  cuda_ver: \"" << escape_json(hw.cuda_version) << "\"\n"
        << "};\n";

    out << "const BENCH_DATA = [\n";
    for (size_t i = 0; i < records.size(); ++i) {
        const auto& r = records[i];
        out << "  {id:" << r.id
            << ", n:" << r.N
            << ", threads:" << r.threads
            << ", algo:\"" << escape_json(r.algo_name) << "\""
            << ", key:\"" << algo_key_str(r.algo_type) << "\""
            << ", time:" << std::fixed << std::setprecision(6) << r.time_sec
            << ", gflops:" << std::fixed << std::setprecision(3) << r.gflops
            << ", speedup:" << std::fixed << std::setprecision(3) << r.speedup
            << ", eff:" << std::fixed << std::setprecision(2) << r.efficiency
            << ", verified:" << (r.verified ? "true" : "false")
            << "}" << (i + 1 < records.size() ? "," : "") << "\n";
    }
    out << "];\n";

    out << R"HTML(
const ALGO_META = {
  seq:         { name: "1. Tuần tự Baseline",       color: "#64748b", group: "cpu",
    pros: "Không tốn chi phí khởi tạo luồng hay copy dữ liệu; ổn định ở kích thước rất nhỏ.",
    cons: "Không tận dụng được các nhân CPU còn lại hay GPU; thời gian tăng bậc O(N³) rất chậm ở N lớn." },
  omp_basic:   { name: "2. OpenMP Cơ bản",          color: "#0284c7", group: "cpu",
    pros: "Đơn giản, ít overhead chỉ số vòng lặp; tận dụng tốt phần cứng khi toàn bộ ma trận nằm lọt trong L3 Cache (N ≤ 512).",
    cons: "Không chia khối Cache Tiling nên trượt L2/L3 Cache nhiều khi N ≥ 1024, bị nghẽn băng thông RAM." },
  omp_l2_l3:   { name: "3. OpenMP Tiled L2+L3",     color: "#2563eb", group: "cpu",
    pros: "Giảm thiểu Cache Miss ở các ma trận trung bình-lớn nhờ tái sử dụng khối con trên L3/L2/L1.",
    cons: "Phát sinh chi phí chỉ số vòng lặp lồng nhau (Loop Overhead) khiến chậm hơn ở N nhỏ (N=512); vẫn bị giới hạn bởi CPU & RAM DDR." },
  omp_bypass:  { name: "4. OpenMP Bypass L2",       color: "#7c3aed", group: "cpu",
    pros: "Nạp dữ liệu thẳng từ L3 xuống L1 Cache, giảm bước đánh chỉ mục trung gian qua L2.",
    cons: "Vẫn bị giới hạn công suất tính toán và băng thông RAM của CPU khi N ≥ 2048." },
  hybrid:      { name: "5. Kết hợp CPU + CUDA GPU", color: "#d97706", group: "hybrid",
    pros: "Huy động đồng thời cả CPU (n-1 luồng) và GPU với cơ chế tự cân bằng tải tỷ trọng, đạt thông lượng rất cao khi CPU đủ mạnh.",
    cons: "Phụ thuộc vào chi phí truyền dữ liệu PCIe và đồng bộ hai thiết bị; nếu CPU quá yếu (ít nhân) có thể làm giảm hiệu quả ở N vừa." },
  cuda_global: { name: "6. CUDA Global Memory",     color: "#dc2626", group: "gpu",
    pros: "Hàng nghìn luồng GPU thực thi song song ồ ạt, vượt xa CPU hoàn toàn ở N ≥ 1024.",
    cons: "Mỗi thread đọc trực tiếp VRAM độ trễ cao (200-400 chu kỳ) mà không tái sử dụng dữ liệu trên chip." },
  cuda_shared: { name: "7. CUDA Shared Tiling",     color: "#16a34a", group: "gpu",
    pros: "Tải từng khối Tile vào Shared Memory tốc độ cao để 256-1024 thread dùng chung, thường đạt tốc độ cao nhất ở N lớn (N ≥ 2048).",
    cons: "Tốn chi phí copy RAM ↔ VRAM qua PCIe và khởi tạo CUDA context nếu chạy ma trận quá nhỏ (N ≤ 256)." }
};

const ALGO_ORDER = ["seq","omp_basic","omp_l2_l3","omp_bypass","hybrid","cuda_global","cuda_shared"];
const uniqueN = [...new Set(BENCH_DATA.map(d => d.n))].sort((a,b) => a - b);
const presentKeys = ALGO_ORDER.filter(k => BENCH_DATA.some(d => d.key === k));
let useLogTime = true;
const hitRegions = {};

function fmt(v, dec=2) { return Number(v).toFixed(dec); }

function renderHardwareAndKPI() {
  const gpuText = HW_INFO.cuda_cores > 0
    ? `${HW_INFO.gpu} (${HW_INFO.cuda_cores} CUDA Cores, ${(HW_INFO.vram_mb/1024).toFixed(2)} GB VRAM)`
    : HW_INFO.gpu;
  document.getElementById("hwGrid").innerHTML = `
    <div class="hw-item"><b>Hệ điều hành &amp; Compiler</b>${HW_INFO.os}<br>${HW_INFO.compiler}</div>
    <div class="hw-item"><b>CPU &amp; Bộ nhớ đệm</b>${HW_INFO.cpu}<br>${HW_INFO.cores}C/${HW_INFO.logical}T | L1:${HW_INFO.l1}KB L2:${HW_INFO.l2}KB L3:${HW_INFO.l3}MB</div>
    <div class="hw-item"><b>GPU (CUDA)</b>${gpuText}</div>
    <div class="hw-item"><b>RAM hệ thống &amp; Quy mô đo</b>${HW_INFO.ram_gb} GB RAM | N: ${uniqueN.join(", ")}</div>
  `;

  const bestG = BENCH_DATA.reduce((a,b) => b.gflops > a.gflops ? b : a, BENCH_DATA[0]);
  const bestS = BENCH_DATA.reduce((a,b) => b.speedup > a.speedup ? b : a, BENCH_DATA[0]);
  const passCount = BENCH_DATA.filter(d => d.verified).length;
  const maxN = uniqueN[uniqueN.length - 1];
  const atMax = BENCH_DATA.filter(d => d.n === maxN);
  const cpuMax = atMax.filter(d => ["seq","omp_basic","omp_l2_l3","omp_bypass"].includes(d.key));
  const gpuMax = atMax.filter(d => ["hybrid","cuda_global","cuda_shared"].includes(d.key));
  const bestCpuAtMax = cpuMax.length ? cpuMax.reduce((a,b)=>b.gflops>a.gflops?b:a) : null;
  const bestGpuAtMax = gpuMax.length ? gpuMax.reduce((a,b)=>b.gflops>a.gflops?b:a) : null;
  const ratioText = (bestCpuAtMax && bestGpuAtMax)
    ? `${(bestGpuAtMax.gflops / bestCpuAtMax.gflops).toFixed(1)}x nhanh hơn CPU thuần`
    : `${fmt(bestG.gflops,1)} GFLOPS tại N=${maxN}`;

  document.getElementById("kpiRow").innerHTML = `
    <div class="kpi"><div class="lbl">Hiệu năng đỉnh đạt được</div><div class="val">${fmt(bestG.gflops,2)} GFLOPS</div><div class="desc">${ALGO_META[bestG.key]?.name || bestG.algo} (N=${bestG.n})</div></div>
    <div class="kpi"><div class="lbl">Tăng tốc cao nhất (Speedup)</div><div class="val">${fmt(bestS.speedup,2)}x</div><div class="desc">${ALGO_META[bestS.key]?.name || bestS.algo} (N=${bestS.n})</div></div>
    <div class="kpi"><div class="lbl">Kiểm định toàn vẹn số học</div><div class="val" style="color:var(--good)">${passCount} / ${BENCH_DATA.length}</div><div class="desc">Trạng thái ĐẠT (OK) theo chuẩn Frobenius</div></div>
    <div class="kpi"><div class="lbl">Tại ma trận lớn nhất (N=${maxN})</div><div class="val" style="color:var(--accent)">${ratioText}</div><div class="desc">Nhanh nhất: ${bestGpuAtMax ? (ALGO_META[bestGpuAtMax.key]?.name) : (ALGO_META[bestCpuAtMax.key]?.name)}</div></div>
  `;
}

// Chọn đại diện tốt nhất (peak GFLOPS) cho mỗi cặp (N, algo_key)
function getBestPerNAndKey(n, key) {
  const matches = BENCH_DATA.filter(d => d.n === n && d.key === key);
  if (!matches.length) return null;
  return matches.reduce((a,b) => b.gflops > a.gflops ? b : a);
}

function setupCanvas(id) {
  const canvas = document.getElementById(id);
  const dpr = Math.max(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width || 540, 420);
  const h = 340;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  return { ctx, w, h };
}

function renderLegend(elId, keys) {
  document.getElementById(elId).innerHTML = keys.map(k =>
    `<div class="legend-item"><span class="swatch" style="background:${ALGO_META[k].color}"></span>${ALGO_META[k].name}</div>`
  ).join("");
}

function drawGroupedBarChart(canvasId, legendId, valueField, yLabel, isLog, unitSuffix) {
  const { ctx, w, h } = setupCanvas(canvasId);
  const pad = { top: 24, right: 20, bottom: 44, left: 66 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  hitRegions[canvasId] = [];

  const vals = [];
  uniqueN.forEach(n => presentKeys.forEach(k => {
    const rec = getBestPerNAndKey(n, k);
    if (rec && rec[valueField] > 0) vals.push(rec[valueField]);
  }));
  if (!vals.length) return;

  let minV = isLog ? Math.min(...vals) * 0.6 : 0;
  let maxV = Math.max(...vals) * (isLog ? 1.8 : 1.15);
  if (isLog && minV <= 0) minV = 1e-4;

  const mapY = (v) => {
    if (isLog) {
      const lv = Math.log10(Math.max(v, minV));
      const lmin = Math.log10(minV), lmax = Math.log10(maxV);
      return pad.top + plotH * (1 - (lv - lmin) / (lmax - lmin || 1));
    }
    return pad.top + plotH * (1 - v / (maxV || 1));
  };

  // Grid & Y ticks
  ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, sans-serif"; ctx.fillStyle = "#475569"; ctx.textAlign = "right";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    let val = isLog
      ? Math.pow(10, Math.log10(minV) + (i / ticks) * (Math.log10(maxV) - Math.log10(minV)))
      : (i / ticks) * maxV;
    const y = pad.top + plotH * (1 - i / ticks);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
    const lbl = val >= 100 ? val.toFixed(0) : (val >= 1 ? val.toFixed(2) : val.toFixed(4));
    ctx.fillText(lbl, pad.left - 8, y + 4);
  }
  ctx.save();
  ctx.translate(16, pad.top + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.font = "bold 11.5px Segoe UI, sans-serif"; ctx.fillStyle = "#334155";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  // Axes
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH); ctx.stroke();

  const grpW = plotW / uniqueN.length;
  const barGap = 4;
  const innerW = grpW * 0.78;

  uniqueN.forEach((n, gi) => {
    const active = presentKeys.map(k => ({ k, rec: getBestPerNAndKey(n, k) })).filter(x => x.rec);
    const bw = Math.max(8, (innerW - barGap * (active.length - 1)) / Math.max(1, active.length));
    const startX = pad.left + gi * grpW + (grpW - (bw * active.length + barGap * (active.length - 1))) / 2;

    active.forEach((item, bi) => {
      const v = item.rec[valueField];
      const bx = startX + bi * (bw + barGap);
      const by = mapY(v);
      const bh = Math.max(2, pad.top + plotH - by);
      ctx.fillStyle = ALGO_META[item.k].color;
      ctx.fillRect(bx, by, bw, bh);

      if (bw >= 18) {
        ctx.fillStyle = "#0f172a"; ctx.font = "bold 10px Segoe UI, sans-serif"; ctx.textAlign = "center";
        const txt = v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
        ctx.fillText(txt, bx + bw / 2, by - 4);
      }

      const tag = ALGO_META[item.k].group === "gpu" ? "GPU" : `${item.rec.threads}T`;
      hitRegions[canvasId].push({
        x: bx, y: by, w: bw, h: bh,
        html: `<b>${ALGO_META[item.k].name}</b> (N=${n}, ${tag})<br>${yLabel}: <b>${fmt(v, valueField==="time"?4:2)}${unitSuffix}</b><br>Speedup: ${fmt(item.rec.speedup,2)}x | ${fmt(item.rec.gflops,2)} GFLOPS`
      });
    });

    ctx.fillStyle = "#1e293b"; ctx.font = "bold 12px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`N = ${n}`, pad.left + gi * grpW + grpW / 2, pad.top + plotH + 20);
  });

  renderLegend(legendId, presentKeys);
}
)HTML";

    out << R"HTML(
function drawLineChart(canvasId, legendId, xValues, seriesList, yLabel, xPrefix, unitSuffix) {
  const { ctx, w, h } = setupCanvas(canvasId);
  const pad = { top: 24, right: 24, bottom: 44, left: 66 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  hitRegions[canvasId] = [];

  const allY = [];
  seriesList.forEach(s => s.points.forEach(p => { if (p !== null) allY.push(p.y); }));
  if (!allY.length || !xValues.length) {
    ctx.fillStyle = "#64748b"; ctx.font = "13px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Chưa đủ điểm dữ liệu đa luồng để vẽ đường cong này.", w / 2, h / 2);
    renderLegend(legendId, []);
    return;
  }

  const maxY = Math.max(...allY) * 1.15 || 1;
  const mapX = (xi) => xValues.length === 1
    ? pad.left + plotW / 2
    : pad.left + (xi / (xValues.length - 1)) * plotW;
  const mapY = (v) => pad.top + plotH * (1 - v / maxY);

  ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, sans-serif"; ctx.fillStyle = "#475569"; ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const val = (i / 5) * maxY;
    const y = pad.top + plotH * (1 - i / 5);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
    ctx.fillText(val >= 100 ? val.toFixed(0) : val.toFixed(1), pad.left - 8, y + 4);
  }
  ctx.save();
  ctx.translate(16, pad.top + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.font = "bold 11.5px Segoe UI, sans-serif"; ctx.fillStyle = "#334155";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(pad.left, pad.top); ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH); ctx.stroke();

  xValues.forEach((xv, xi) => {
    const x = mapX(xi);
    ctx.fillStyle = "#1e293b"; ctx.font = "bold 12px Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(xPrefix + xv, x, pad.top + plotH + 20);
  });

  seriesList.forEach(s => {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2.4;
    ctx.beginPath();
    let started = false;
    s.points.forEach((pt, xi) => {
      if (!pt) { started = false; return; }
      const px = mapX(xi), py = mapY(pt.y);
      if (!started) { ctx.moveTo(px, py); started = true; }
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    s.points.forEach((pt, xi) => {
      if (!pt) return;
      const px = mapX(xi), py = mapY(pt.y);
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(px, py, 3.6, 0, Math.PI * 2); ctx.fill();
      hitRegions[canvasId].push({
        x: px - 8, y: py - 8, w: 16, h: 16,
        html: `<b>${s.label}</b> (${xPrefix}${xValues[xi]})<br>${yLabel}: <b>${fmt(pt.y,2)}${unitSuffix}</b><br>${pt.extra || ""}`
      });
    });
  });

  renderLegend(legendId, seriesList.map(s => s.key));
}

function drawSpeedupChart() {
  const series = presentKeys.map(k => ({
    key: k, label: ALGO_META[k].name, color: ALGO_META[k].color,
    points: uniqueN.map(n => {
      const r = getBestPerNAndKey(n, k);
      return r ? { y: r.speedup, extra: `GFLOPS: ${fmt(r.gflops,2)} | Time: ${fmt(r.time,4)}s` } : null;
    })
  }));
  drawLineChart("cSpeedup", "leg3", uniqueN, series, "Speedup (lần)", "N=", "x");
}

function initScaleSelector() {
  const sel = document.getElementById("nScaleSelect");
  const multiN = uniqueN.filter(n => {
    const tset = new Set(BENCH_DATA.filter(d => d.n === n && ["omp_basic","omp_l2_l3","omp_bypass","hybrid"].includes(d.key)).map(d => d.threads));
    return tset.size >= 1;
  });
  const opts = multiN.length ? multiN : uniqueN;
  sel.innerHTML = opts.map(n => `<option value="${n}">N = ${n}</option>`).join("");
  sel.value = opts[opts.length - 1];
}

function drawThreadScaling() {
  const nVal = Number(document.getElementById("nScaleSelect").value || uniqueN[0]);
  const scaleKeys = ["omp_basic","omp_l2_l3","omp_bypass","hybrid"].filter(k =>
    BENCH_DATA.some(d => d.n === nVal && d.key === k)
  );
  const threads = [...new Set(BENCH_DATA.filter(d => d.n === nVal && scaleKeys.includes(d.key)).map(d => d.threads))].sort((a,b) => a - b);
  const series = scaleKeys.map(k => ({
    key: k, label: ALGO_META[k].name, color: ALGO_META[k].color,
    points: threads.map(t => {
      const r = BENCH_DATA.find(d => d.n === nVal && d.key === k && d.threads === t);
      return r ? { y: r.gflops, extra: `Speedup: ${fmt(r.speedup,2)}x | Time: ${fmt(r.time,4)}s` } : null;
    })
  }));
  drawLineChart("cThreads", "leg4", threads, series, "GFLOPS", "Threads=", " GFLOPS");
}

function renderComparisonAndProsCons() {
  let rowsHtml = `<table><thead><tr>
    <th>Kích thước N</th><th>Nhanh nhất (Tối ưu)</th><th>CPU thuần tốt nhất</th>
    <th>Hybrid CPU+GPU</th><th>GPU thuần tốt nhất</th><th>Tỷ lệ GPU / CPU thuần</th>
  </tr></thead><tbody>`;

  uniqueN.forEach(n => {
    const atN = BENCH_DATA.filter(d => d.n === n);
    const best = atN.reduce((a,b) => b.gflops > a.gflops ? b : a);
    const cpuList = atN.filter(d => ["seq","omp_basic","omp_l2_l3","omp_bypass"].includes(d.key));
    const hybList = atN.filter(d => d.key === "hybrid");
    const gpuList = atN.filter(d => ["cuda_global","cuda_shared"].includes(d.key));

    const bCpu = cpuList.length ? cpuList.reduce((a,b) => b.gflops > a.gflops ? b : a) : null;
    const bHyb = hybList.length ? hybList.reduce((a,b) => b.gflops > a.gflops ? b : a) : null;
    const bGpu = gpuList.length ? gpuList.reduce((a,b) => b.gflops > a.gflops ? b : a) : null;
    const ratio = (bCpu && (bGpu || bHyb))
      ? `${((Math.max(bGpu ? bGpu.gflops : 0, bHyb ? bHyb.gflops : 0)) / bCpu.gflops).toFixed(2)}x`
      : "-";

    rowsHtml += `<tr>
      <td><b>N = ${n}</b></td>
      <td><span class="badge">${ALGO_META[best.key]?.name} (${fmt(best.gflops,2)} GFLOPS)</span></td>
      <td>${bCpu ? `${ALGO_META[bCpu.key].name} (${bCpu.threads}T): <b>${fmt(bCpu.gflops,2)}</b>` : "-"}</td>
      <td>${bHyb ? `(${bHyb.threads}T): <b>${fmt(bHyb.gflops,2)}</b>` : "-"}</td>
      <td>${bGpu ? `${ALGO_META[bGpu.key].name}: <b>${fmt(bGpu.gflops,2)}</b>` : "-"}</td>
      <td><b>${ratio}</b></td>
    </tr>`;
  });
  rowsHtml += "</tbody></table>";
  document.getElementById("milestoneTable").innerHTML = rowsHtml;

  document.getElementById("prosGrid").innerHTML = presentKeys.map(k => {
    const recs = BENCH_DATA.filter(d => d.key === k);
    const minG = Math.min(...recs.map(r => r.gflops));
    const maxG = Math.max(...recs.map(r => r.gflops));
    const m = ALGO_META[k];
    return `<div class="pro-card" style="border-left-color:${m.color}">
      <h3 style="color:${m.color}">${m.name} (${fmt(minG,1)} – ${fmt(maxG,1)} GFLOPS)</h3>
      <ul>
        <li><b>Ưu điểm:</b> ${m.pros}</li>
        <li><b>Nhược điểm:</b> ${m.cons}</li>
      </ul>
    </div>`;
  }).join("");
}

function toggleLog() {
  useLogTime = !useLogTime;
  document.getElementById("btnLog").innerText = "Thang Log: " + (useLogTime ? "BẬT" : "TẮT");
  drawGroupedBarChart("cTime", "leg2", "time", "Thời gian (s)", useLogTime, "s");
}

function downloadChart(canvasId, fileName) {
  const canvas = document.getElementById(canvasId);
  const link = document.createElement("a");
  link.download = fileName;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function bindTooltips() {
  const tip = document.getElementById("tooltip");
  ["cGflops","cTime","cSpeedup","cThreads"].forEach(id => {
    const c = document.getElementById(id);
    c.addEventListener("mousemove", e => {
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const list = hitRegions[id] || [];
      const hit = list.find(r => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);
      if (hit) {
        tip.style.display = "block";
        tip.innerHTML = hit.html;
        tip.style.left = (e.clientX + 14) + "px";
        tip.style.top = (e.clientY - 12) + "px";
      } else {
        tip.style.display = "none";
      }
    });
    c.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });
}

function drawAll() {
  drawGroupedBarChart("cGflops", "leg1", "gflops", "Hiệu năng (GFLOPS)", false, " GFLOPS");
  drawGroupedBarChart("cTime", "leg2", "time", "Thời gian (s)", useLogTime, "s");
  drawSpeedupChart();
  drawThreadScaling();
}

renderHardwareAndKPI();
initScaleSelector();
renderComparisonAndProsCons();
drawAll();
bindTooltips();
window.addEventListener("resize", drawAll);
</script>
</body>
</html>
)HTML";

    out.close();
    return true;
}
