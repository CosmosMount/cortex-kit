# Changelog

## 0.1.12 — 2026-09-12

本次发布准备版本汇总了 0.1.5 之后的本地迭代。

### 新增

- 手动选择 ST-Link 或 DAPLink / CMSIS-DAP，识别设备并按 selector 绑定后连接。
- 独立的探针 / 采样配置向导，显式选择协议、时钟、连接方式及最大吞吐请求。
- Plot 可选 1–600 秒时间窗口，支持文件夹设置；结束会话后可选择单个或多个图表合并导出 PNG。
- Threads 增加栈内存占用百分比，以保存的 SP 估算，缺失数据不计算。
- 中文插件使用指南、参考项目致谢、MIT License 和发布流程。

### 修复与改进

- 采样批次按实测读取耗时调整，降低高请求频率下暂停命令的等待时间。
- Sample 持续后台录制；隐藏或关闭视图不停止，临时数据错误后可继续同一 CSV。
- Plot 保留结束会话后的数据，并恢复面板隐藏期间收到的数据；缓存有时间及数值数量上限。
- 移除 Threads 的运行时间计数器占比列，保留观测式运行占比。
- 修复 `cortexKit.historySeconds` 写入 Folder Settings 时的资源作用域错误。

### 验证范围

Windows x64；ST-Link 与 STM32H723VG，以及 Horco CMSIS-DAP 的连接、采样、暂停 / 继续。请求 100000 S/s 不代表实测达到该速度；DAPLink 烧录及更多设备组合仍待验证。

## 0.1.5

已有功能包括实时变量与 Plot / FFT、CSV 记录和导入、ThreadX / FreeRTOS 线程检查、独立 Live Watch 速率、CMake 构建快捷键和独立烧录。详细开发记录见 Git 历史及 `docs/`。
