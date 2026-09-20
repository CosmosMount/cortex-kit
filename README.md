# Cortex Kit

在 VS Code 中连接 Cortex-M，查看实时变量、绘制时域 / FFT 曲线、持续记录 CSV，并完成固件烧录和基础调试。

Cortex Kit 通过 Rust 后端和 [probe-rs](https://probe.rs/) 直接访问 ST-Link、DAPLink / CMSIS-DAP，无需配置 OpenOCD 或 GDB Server。当前发布包适用于 **Windows x64、VS Code 1.96 及以上版本**，仍处于早期版本阶段。

## 安装

获取 `cortex-kit-win32-x64.vsix` 后，在 VS Code 命令面板中执行 **Extensions: Install from VSIX...**，或运行：

```powershell
code --install-extension .\cortex-kit-win32-x64.vsix
```

更新已运行的版本后执行 **Developer: Reload Window**。插件会同时安装 CMake Tools 和 C/C++ 扩展；已有 ELF / AXF 时，无需安装编译器即可连接和查看变量。需要编译时，再安装项目使用的 CMake、Ninja 等构建工具和 Arm 编译器。

## 第一次连接

1. 在 VS Code 打开固件工程文件夹，准备与板上固件一致、包含 DWARF 调试信息的 ELF / AXF 文件。
2. 将探针连接到目标板。SWD 通常需要 GND、SWDIO、SWCLK，以及探针要求的参考电压连接；目标板需要供电。
3. 执行 **Cortex Kit: Configure Project**，按向导选择芯片、固件和探针。芯片名使用向导中的 probe-rs 目标名，例如 STM32H723VGT6 对应已验证的 `STM32H723VG`。
4. 手动选择 **ST-Link** 或 **DAPLink / CMSIS-DAP**，绑定扫描到的设备，选择 SWD / JTAG、调试时钟和采样频率。典型 SWD 连接可先使用 **10000 kHz** 和 **Normal connection**。
5. 在“运行和调试”中选择 **Cortex Kit: Live Plot (Attach)**，按 **F5** 连接正在运行的固件。需要烧录时选择 **Cortex Kit: Flash & Debug**。
6. 从 **Cortex Kit Variables** 添加变量到 **Live Watch**，在底部 **Plot** 中添加图表及变量，即可观察数据。

向导会保存 `.vscode/launch.json`。再次运行 Configure Project 会替换已有 Cortex Kit 配置，保留其他调试器的配置；只修改探针或速率时，请使用下面的 Configure Probe / Sampling。

## 选择、绑定和切换探针

已有项目可执行 **Cortex Kit: Select ST-Link / DAPLink and Connect**，或点击 **Session / Live Watch** 标题栏的插头按钮：

- 先选择探针类型。只有一个匹配设备时自动绑定；多个设备时按序列号选择；没有设备时可连接后点击 **Retry**，不会自动改用另一类探针。
- 选择目标配置后，将设备的准确 selector 保存到该配置，并以 Live Plot attach 模式连接。连接时跳过构建、烧录和连接复位；保存的配置仍保留原来的启动行为。
- 取消选择不会写入配置。切换探针前先结束当前 Cortex Kit 会话；无法区分的重复 selector 需要先断开多余设备。

执行 **Cortex Kit: Configure Probe / Sampling** 可修改已有配置的探针、协议、时钟、连接方式和请求采样率，同时保留芯片、固件、SVD 等配置。

**DAPLink 已通过 CMSIS-DAP 后端接入。** Horco CMSIS-DAP 已使用 `robomaster/pnx_template` 的 STM32H723VG 固件验证连接、烧录、校验、复位、连续压力采样、暂停和继续；不同 DAPLink 固件仍需分别验证。ST-Link 同样已验证连接、采样、烧录与校验。更多实测见 [pnx_template DAPLink 压力测试](docs/performance/2026-09-20/DAPLINK_ROBOMASTER_PNX_TEMPLATE.md)。

### 手动配置示例

下面的 attach 配置适合查看板上已有固件。修改芯片和 ELF 路径；多探针场景建议通过上述命令绑定准确设备。

```jsonc
{
  "version": "0.2.0",
  "configurations": [{
    "name": "Cortex Kit: Live Plot (Attach)",
    "type": "cortex-kit",
    "request": "attach",
    "cwd": "${workspaceFolder}",
    "chip": "STM32H723VG",
    "programBinary": "${workspaceFolder}/build/Debug/firmware.elf",
    "plotOnly": true,
    "stopOnEntry": false,
    "probe": {
      "selector": "auto",
      "protocol": "swd",
      "speedKHz": 10000,
      "connectUnderReset": false
    },
    "flashing": { "enabled": false, "verify": false, "resetAfter": false },
    "acquisition": { "requestedSamplesPerSecond": 100000, "historySeconds": 30 }
  }]
}
```

## Live Watch 与变量修改

插件会在连接前从 ELF 索引全局 / 静态变量、结构体、数组和带 DWARF 指向类型的全局指针。展开结构体、数组或对象指针后，可直接通过成员旁的眼睛或曲线按钮添加单个标量；在容器节点上执行添加操作时，会先打开内部标量列表供你多选，不会默认加入整个对象。指针成员按采样批次读取当前指针值后访问；空指针显示为不可用值，不会读取地址 0。

点击 Live Watch 中可写变量的铅笔按钮即可修改值。插件会按类型校验输入、暂停目标、写入并回读校验，然后恢复之前的运行状态。增加或删除采集变量也可能短暂暂停目标；仅调整图表布局不会触发暂停。

Live Plot 模式允许主动暂停 / 继续和上述变量写入，禁止烧录、复位、单步、任意内存写入及安装断点。

## Plot：实时曲线、时间窗口与图片导出

在底部 **Plot** 点击 **Add chart**，通过 **+ Variable** 勾选具体标量变量。结构体和数组会显示为各自的内部标量成员。图表支持 Time、FFT、Time + FFT，以及表达式、联动光标和拖动排序。顶部可切换网格、横排或竖排布局。

**时间窗口**可选 5 / 10 / 30 秒、1 / 2 / 5 / 10 分钟，或自定义 **1–600 秒**。选择会保存到 `cortexKit.historySeconds`，支持工作区文件夹设置，立即生效且不改变采样率。增大窗口后逐步积累新数据；已丢弃的旧数据不能恢复。缩小窗口会裁去旧数据。

点击 **导出图片**，勾选一个或多个图表并选择保存位置，即可按当前图表顺序竖向合并为一张 **1800 像素宽的 PNG**，保留标题、完整变量图例和各自的 Time / FFT 模式。导出使用生成图片时的当前数据，不暂停目标。

暂停或结束调试后仍可导出；隐藏再打开面板也会恢复保留数据。开始新的目标会话会清空旧数据，重载 VS Code 后不保留。缓存最多保留所选时间窗口及约 800 万个数值，高速、多变量采集可能实际保留更短。需要完整记录时使用 Sample / CSV。合并图片过大时，请分批选择图表。

## Sample：持续后台记录与 CSV 查看

执行 **Cortex Kit: Sample / CSV** 打开底部 **Sample**：

1. 点击 **选择变量**，最多选择 64 个标量，输入请求频率 **1–100000 S/s**。
2. 点击 **开始记录**并选择 CSV 保存位置。尚未连接时会选择已有配置，以不烧录、不复位、不执行构建任务的方式 attach。目标暂停时需 Continue 才能产生样本。
3. 记录会持续写入磁盘，直到点击 **停止并保存**。没有定时自动停止；隐藏、关闭或重新打开 Sample 面板不会中断后台记录。
4. 暂停目标期间保持文件打开，继续后在同一 CSV 中保留实际时间间隔。临时读取失败或数据连接重连会等待新样本；会话结束 / 切换、VS Code 扩展宿主退出、磁盘写入失败或写入积压超过限制时会结束记录并报告状态。
CSV 为带 BOM 的 UTF-8，列为 `elapsed_s,timestamp_ns,stream_epoch,<变量...>`。时间戳来自适配器的单调主机时钟和实测读取批次，不是 UTC 或目标固件时间戳。记录只使用真实收到的样本，不通过插值或重复值补齐请求频率。预览只保留最近 4000 行，CSV 写入全部实际记录行。采样选择、抽样、预览聚合与文件写入均在 Rust 数据核心完成。

## 外设、构建、烧录与调试

- **外设寄存器**：执行 **Cortex Kit: Select SVD File** 选择 CMSIS-SVD，或设置 `svdFile`。`.s` 汇编和 `.ld` 链接脚本不能代替 SVD。
- **F7 / Cortex Kit: Build**：调用 CMake Tools 构建。先在 CMake Tools 配置工具链、预设和构建目录。
- **F8 / Cortex Kit: Flash**：选择固件配置，执行其 `preLaunchTask`（如有），烧录后启动目标并断开；无构建任务时直接使用现有镜像。支持 ELF / AXF / OUT、HEX、BIN、UF2，非 ELF 格式仍需更广泛实机验证。
- **F5**：启动所选配置，调试过程中继续执行。Flash & Debug 可烧录、校验并复位；F7 / F8 的构建烧录快捷键在调试期间让位于调试快捷键。
- **Cortex Kit: Import Cortex-Debug Configuration**：从已有 Cortex-Debug 配置导入可识别字段，连接前检查目标、固件和探针设置。
- **Cortex Kit: Mock Debug**：无硬件时体验模拟调试与采样。

当前支持基础暂停 / 继续、硬件断点、单指令步进、CPU 寄存器和内存访问。真实调用栈展开、帧局部变量、源码级 Step Over / Out 和完整反汇编尚未完成，详见 [实现状态](docs/IMPLEMENTATION_STATUS.md)。

## 尽量提高采样速度

通过 **Configure Probe / Sampling → Maximum throughput** 请求 **100000 S/s**，再根据实际稳定性调整调试时钟。请求频率是调度目标，不是保证达到的采样率。

| 设置 | 含义 |
| --- | --- |
| `probe.speedKHz` | SWD / JTAG 请求时钟，单位 kHz；10000 表示 10 MHz。探针实际协商值显示在 Session 的 Probe 项中 |
| `acquisition.requestedSamplesPerSecond` | Plot 请求采样频率；Maximum throughput 为 100000 S/s |
| Sample 中的采样频率 | CSV 请求记录频率，与其他采集共享探针 |
| `cortexKit.liveWatchSamplesPerSecond` | 仅 Live Watch 变量的请求频率，默认 20 S/s |
| `cortexKit.chartRefreshRate` | Plot 绘制刷新率，默认 30 FPS，不是采样率 |
| `cortexKit.historySeconds` | Plot 滚动显示与保留时长，不会定时停止 Sample |

减少同时监视的变量，优先使用地址连续的普通 RAM 变量，再观察实际速率和丢帧。图表之间的重复变量会共享读取。CMSIS-DAP 返回的时钟是请求上限，不能据此认定实际物理时钟；提高时钟未必提高吞吐量。使用 `robomaster/pnx_template`、STM32H723VG 和 Horco CMSIS-DAP 的最终 30 秒实测中，8 个连续浮点通道为 371.78 S/s，32 个分散 32 位通道为 83.65 S/s，均为零读错、零丢帧；完整条件见 [pnx_template DAPLink 压力测试](docs/performance/2026-09-20/DAPLINK_ROBOMASTER_PNX_TEMPLATE.md)。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| DAPLink 未出现在列表中 | 检查 USB 数据线及设备是否暴露 CMSIS-DAP，关闭占用探针的其他软件，再 Retry |
| 换探针后连不上 | 结束旧会话，重新运行 Select ST-Link / DAPLink and Connect，避免沿用旧序列号 |
| 连接失败或数据不稳定 | 核对芯片名、目标供电及 SWD 接线，降低时钟；只有已接 NRST 且需要复位连接时才选 Under reset |
| 变量缺失或数值不对 | 使用与正在运行固件一致的带 DWARF ELF；优化可能消除变量，重新构建后更新 ELF |
| Plot 停止变化 | 检查目标是否暂停、会话是否结束，以及是否已选变量；查看 Cortex Kit 输出中的连接状态 |
| `historySeconds` 无法写入 Folder Settings | 更新至 0.1.12 或更新版本并 Reload Window；该设置现已声明文件夹资源作用域 |
| 内存百分比显示 `—` | 核对 RTOS 内核调试信息和所需栈字段；插件不会用未知栈大小计算百分比 |

反馈问题请提交到 [GitHub Issues](https://github.com/CosmosMount/cortex-kit/issues)，附插件版本、探针型号、芯片名、复现步骤及相关输出。提交前移除日志中不希望公开的固件路径或设备标识。

## 致谢

感谢以下两个参考项目及其作者、贡献者：

- [MemRW3](https://github.com/SuperLiaohy/MemRW3)：为 Rust 采集数据路径、DWARF / SVD / FFT 模块划分和单一 ProbeWorker 的设计提供了参考。
- [Cortex-Debug](https://github.com/Marus/cortex-debug)：为 VS Code 调试扩展的交互方式和配置体验提供了参考。

Cortex Kit 使用独立的工程结构和通信协议，参考关系见 [架构说明](docs/ARCHITECTURE.md)。同时感谢 [probe-rs](https://probe.rs/) 及其他依赖项目提供的基础能力；第三方组件遵循各自的许可证。

## 许可证与开发

Cortex Kit 原创代码采用 [MIT License](LICENSE)。开发、验证与发布步骤见 [发布指南](docs/RELEASING.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。
