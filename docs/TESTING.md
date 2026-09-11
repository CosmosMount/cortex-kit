# Testing in VS Code

## Build and automated checks

From PowerShell:

```powershell
cd D:\Workspace\projects\cortex-kit
.\scripts\cargo.ps1 test --workspace
.\scripts\cargo.ps1 build --workspace
cd extension
npm ci
npm test
npm run test:dap
```

The helper uses `cargo` from `PATH` when available. On this development machine it can also use the ignored, repository-local `.tooling` installation. The normal project does not install or modify an Arm GNU toolchain.

## Mock Probe in the Extension Development Host

1. Open `D:\Workspace\projects\cortex-kit` in VS Code.
2. Press `Ctrl+Shift+B` and run **Build Cortex Kit**.
3. Press `F5` and select **Run Extension** if VS Code asks for a launch target.
4. In the new Extension Development Host, run **Cortex Kit: Mock Debug** from the Command Palette.
5. Use Continue, Pause, Step Into, Step Over, Step Out, Restart, and Stop from Run and Debug.
6. Inspect **Cortex Kit Variables**, expand the mock `signal` structure, and inspect **Cortex Kit Session**, Call Stack, Locals, Statics, and CPU Registers.
7. Open the bottom **Cortex Kit** panel. Use **＋ Variable** on each chart, select `signal.sine_37hz` and other signals, press Continue because Mock Debug stops on entry, create more charts, and switch each chart among Time, FFT, and Time + FFT.
8. Add an `fx` expression such as `signal.sine_37hz * 2 + control.ramp`.
9. Move the pointer over a chart to check the linked cursor, rename a chart, remove a signal, and reload the Webview to check layout persistence.
10. Switch between dark, light, and high-contrast themes.

The checked-in Extension Host launch passes `--disable-extensions`. The development copy of Cortex Kit still loads, while unrelated installed extensions stay disabled. This keeps Cortex-Debug companion views and other debug trackers from attaching themselves to the Extension Host debug session. The Rust build task intentionally has an empty `problemMatcher`; `$rustc` is not a built-in VS Code matcher.

The repository also contains the packaged extension [cortex-kit-win32-x64.vsix](../cortex-kit-win32-x64.vsix). Install it from **Extensions: Install from VSIX...** when a Development Host is not needed.

## Variables before debugging

Cortex Kit activates after the workspace starts and reads `.vscode/launch.json` without opening a probe. It first looks for `programBinary` in `type: "cortex-kit"` configurations and can also index the `executable` field in existing `type: "cortex-debug"` configurations. ELF, AXF, and OUT files are passed to the bundled `--inspect-elf` backend; HEX, BIN, and UF2 images cannot provide an offline DWARF catalog.

1. Open a firmware workspace containing an ELF/AXF referenced by `launch.json`.
2. Open Run and Debug. **Cortex Kit Variables** should show the ELF filename and the number of addressable scalar fields before F5 is pressed.
3. Expand a structure or array directly in the tree.
4. Click the search icon in the Variables title, or run **Cortex Kit: Search Global Variables**. Search by a root name, a full field expression such as `AliveThread.tx_thread_priority`, a type, or an address; multiple selected fields are added to Plot together.
5. Rebuild the ELF and confirm the catalog refreshes after the linker replaces it. **Cortex Kit: Refresh Views** forces a reparse.

If a workspace only has Cortex-Debug entries, it is already sufficient for offline variable lookup. Run **Cortex Kit: Import Cortex-Debug Configuration** to add a launchable Cortex Kit entry; the import maps `executable`, `cwd`, `device`, `preLaunchTask`, and `svdFile`, and removes OpenOCD-specific fields. Existing Cortex-Debug configurations are preserved.

## SVD and peripheral registers

An SVD describes a chip's peripheral blocks, register addresses, bit fields, access rules, and reset values. Startup assembly (`.s` or `.S`) defines the reset/vector code, while a linker script (`.ld`) places program sections in memory; neither file contains a complete peripheral register description.

Use either of these equivalent setup paths:

1. Run **Cortex Kit: Select SVD File** and select a local `.svd`. Cortex Kit writes the selected path into every Cortex Kit entry in the workspace `launch.json` and loads it immediately.
2. Set the launch property directly, for example `"svdFile": "${workspaceFolder}/.vscode/svd/STM32H723.svd"`.

If exactly one `.svd` exists in the workspace, Cortex Kit also discovers it automatically. The native **Cortex Kit Peripherals** tree is available before F5 and uses the Rust SVD parser to expand inherited peripherals, register arrays, clusters, and bit fields. An active Cortex Kit session is required only for live reads and writes. Click a register to read it into the tree; expanding that register then shows decoded field values. The write action appears only when the SVD marks the register writable.

## Live Watch

- Adding a Plot or Live Watch subscription while the target is running performs a short automatic pause, updates the subscription, and resumes the target.
- Editing a Live Watch value performs pause, typed write, flush, hardware readback, and resume as one adapter transaction.
- Select a structure or array in the variable picker to add all addressable scalar descendants; individual fields remain selectable.
- In the Plot header, choose Auto grid, Side by side, or Stacked. Drag the handle at the left of a chart title to reorder charts.

The native **Cortex Kit Live Watch** view is independent from Plot:

1. Click **+** in the Live Watch title or use **Add to Live Watch** on a scalar in **Cortex Kit Variables**. Structure fields and array elements can be selected individually.
2. Start a Cortex Kit launch or attach session. Values update while the target runs. Expand a row to inspect its full value, type, expression, address, width, access mode, update timestamp, and measured sample rate.
3. In either **Cortex Kit: Live Plot (Attach)** or **Cortex Kit: Flash & Debug**, use the pencil action on a writable row. Enter a decimal, hexadecimal, floating-point, or boolean value matching its DWARF type and press Enter. Cortex Kit briefly pauses the running target, writes the correctly sized little-endian representation through the ProbeWorker, flushes the probe transfer, reads the hardware value back, and resumes automatically. The acknowledged value remains visible for 500 ms while queued pre-write samples are buffered. A firmware task that later overwrites the parameter appears as a subsequent value change. Live Plot does not flash or reset the target.
4. Use **Add Live Watch Variable to Plot** only when the same value should also be charted. Adding or removing a Live Watch row does not change any chart, and changing a chart does not change Live Watch.

Live Watch selections are stored in workspace state. Plot and Live Watch share a deduplicated hardware read when they select the same leaf. `cortexKit.liveWatchSamplesPerSecond` defaults to 20 S/s when Live Watch is the only acquisition consumer, and `cortexKit.liveWatchRefreshRate` limits native tree updates to 10 per second. Both existing Cortex Kit configurations expose the same Live Watch view and persisted selection.

For STM32H723, use `STM32H723.svd` from the [Open-CMSIS-Pack STM32H7 Device Family Pack](https://github.com/Open-CMSIS-Pack/STM32H7xx_DFP/blob/main/CMSIS/SVD/STM32H723.svd). The SVD is shared across the STM32H723 package and memory-size variants. Validate any local file without opening VS Code:

```powershell
.\target\release\cortex-kit-dap.exe --inspect-svd path\to\STM32H723.svd
```

## Existing STM32H723VGT6 firmware

1. Open the existing firmware workspace in the Extension Development Host or install the VSIX into the normal VS Code window.
2. Run **Cortex Kit: Configure Project**.
3. Select the detected ST-Link or DAPLink.
4. Search the probe-rs list for `STM32H723VG` and select that exact entry. Probe-rs 0.31 reports this target for STM32H723VGT6.
5. Select the existing ELF/AXF and `STM32H723.svd`. Choose the existing build task or **Use existing binary without build**.
6. Review the generated `.vscode/launch.json`. A typical configuration is:

```json
{
  "type": "cortex-kit",
  "request": "launch",
  "name": "Cortex Kit",
  "cwd": "${workspaceFolder}",
  "chip": "STM32H723VG",
  "programBinary": "${workspaceFolder}/build/firmware.elf",
  "probe": { "selector": "auto", "protocol": "swd", "speedKHz": 10000, "connectUnderReset": false },
  "flashing": { "enabled": true, "verify": true, "resetAfter": true },
  "acquisition": { "requestedSamplesPerSecond": 5000, "maxBurstMs": 2, "historySeconds": 30 },
  "svdFile": "${workspaceFolder}/.vscode/svd/STM32H723.svd"
}
```

Set `probe.connectUnderReset` to `true` if the target's current firmware prevents a normal SWD attach and the probe's reset pin is connected. Cortex Kit then asks probe-rs to assert hardware reset while establishing the session. Leave it `false` for the normal, non-resetting attach path.

For protected live plotting, add a second configuration with `"request": "attach"`, `"plotOnly": true`, `"stopOnEntry": false`, and all three `flashing` options set to `false`. Plot-only mode resumes acquisition when attach completes, keeps explicit Pause/Continue and typed Live Watch writes available, and rejects flash, reset, stepping, arbitrary memory writes, and source/instruction breakpoint installation. A Live Watch write still changes target RAM, but only after an explicit pencil action and only for an ELF variable marked writable. Sampling uses debug-port and memory-bus bandwidth; start with a moderate requested rate and measure the effect on time-sensitive firmware.

7. Before pressing F5, confirm **Cortex Kit Variables** is populated and use **Cortex Kit: Search Global Variables** to add one or more fields to Plot. Then press `F5` and check flash/verify/reset, an instruction breakpoint, a source breakpoint, CPU registers, static values, memory, continue, pause, and stepping. Preselected plot fields are subscribed automatically when the session begins.
8. On a breakpoint, confirm VS Code marks the stopped source row and **Cortex Kit Session** shows a clickable **Continue** item. The Variables tree refreshes visible scalar values at that stop; expand a structure before the next stop to include its visible fields.
9. In **Cortex Kit Peripherals**, expand a peripheral while halted to refresh its readable registers, or click a register to read it immediately. Expanding a register shows decoded fields; right-click a writable register and choose **Write Register**.
10. Add existing numeric globals/statics to charts. Reuse one variable in multiple charts and confirm it is acquired once.
11. Run **Cortex Kit: Run Acquisition Benchmark**, select up to eight variables, and save the output from **Cortex Kit Benchmark**.

For an isolated normal VS Code window, create or open the `Cortex Kit` profile and install the VSIX into that profile:

```powershell
code --profile "Cortex Kit" --install-extension D:\Workspace\projects\cortex-kit\cortex-kit-win32-x64.vsix --force
code --new-window --profile "Cortex Kit" D:\Workspace\robomaster\wbr_2026
```

A newly created profile has its own extension list and settings, so Cortex-Debug and unrelated user extensions do not participate in this window. VS Code's built-in editor, Run and Debug, source control, and terminal remain available.

Record probe type and serial, target, SWD speed, variable addresses and widths, address grouping, requested/actual rate, mean/p95/p99 interval, read errors, dropped frames, and pause response. Repeat with ST-Link and DAPLink. A successful UI and transport smoke test does not establish the 8 × 5 kS/s claim; that claim needs physical measurements with the user's existing program and selected contiguous variables.

Structure members and array elements appear when the ELF/AXF contains DWARF type information. For example, `telemetry.speed` and `telemetry.history[2]` can be selected independently. A stripped image can still expose linker data symbols, but it cannot recover member names or offsets. To inspect what the backend finds without connecting a probe:

```powershell
.\target\debug\cortex-kit-dap.exe --inspect-elf path\to\firmware.elf
```

## Hardware DAP smoke harness

`tests\hardware-dap-smoke.mjs` exercises the same DAP executable and binary sample protocol used by the extension without requiring the VS Code UI. Build the Rust adapter and TypeScript protocol decoder before running it:

```powershell
cd D:\Workspace\projects\cortex-kit
.\scripts\cargo.ps1 -CargoArguments @('build', '-p', 'cortex-kit-dap', '--release', '--locked', '--offline')
cd extension
npm run compile
cd ..
```

The command accepts 14 positional arguments in this order:

```text
node tests\hardware-dap-smoke.mjs <firmware.elf> [probe-selector] [seconds] [speed-khz] [connect-under-reset] [flash] [validate-pause] [requested-sps] [representative|contiguous] [channel-count] [source-file:line] [benchmark-seconds] [debug|release] [plot-only]
```

| Position | Argument | Default | Meaning |
| --- | --- | --- | --- |
| 1 | `firmware.elf` | required | ELF/AXF containing symbols and, preferably, DWARF information. |
| 2 | `probe-selector` | `auto` | A probe-rs selector. For example, `STLink V2-1,SN:<ST-LINK-SERIAL>`. |
| 3 | `seconds` | `2` | Time spent collecting streamed binary batches before debug-control checks. Minimum 0.25 seconds. |
| 4 | `speed-khz` | `1000` | Requested SWD clock in kHz. |
| 5 | `connect-under-reset` | `true` | Whether to assert hardware reset while attaching. Use `false` for a normal attach. |
| 6 | `flash` | `false` | `true` uses DAP `launch` to program, verify, and reset; `false` uses `attach`. |
| 7 | `validate-pause` | `true` | Pause the target, read the CPU Registers scope, then continue it. |
| 8 | `requested-sps` | `1000` | Requested complete sample frames per second, independent of channel count. |
| 9 | channel profile | `representative` | Select the firmware-specific dispersed or contiguous test set described below. |
| 10 | `channel-count` | `8` | Maximum number of scalar leaves selected from the profile. The result reports the number actually found. |
| 11 | `source-file:line` | disabled | Optional source breakpoint. The parser uses the final colon, so a Windows drive letter is supported. |
| 12 | `benchmark-seconds` | `0` | Duration of the direct acquisition benchmark; `0` disables it. |
| 13 | backend profile | `debug` | Select the adapter from `target\debug` or `target\release`. Build that profile first. |
| 14 | `plot-only` | `false` | Protected attach mode. `true` allows explicit pause/continue while rejecting flash, reset, stepping, writes, and hardware breakpoint installation. It requires arguments 6 and 7 to be `false` and no source breakpoint. |

Boolean arguments accept `true`/`false`, `1`/`0`, or `yes`/`no`. Pass `release` explicitly in argument 13 when reproducing packaged-extension behavior; the JSON result includes `backendProfile` so saved reports remain distinguishable. The harness always attempts to remove a source breakpoint, resume a halted target, and disconnect cleanly, including after a failed assertion.

The `wbr_2026` firmware can be sampled without flashing it again:

```powershell
node tests\hardware-dap-smoke.mjs `
  "D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf" `
  "STLink V2-1,SN:<ST-LINK-SERIAL>" `
  2 4000 false false true 5000 representative 8 "" 0 release
```

Set argument 6 to `true` only when the same image should be programmed before the test:

```powershell
node tests\hardware-dap-smoke.mjs `
  "D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf" `
  "STLink V2-1,SN:<ST-LINK-SERIAL>" `
  2 4000 false true true 1000 representative 8 "" 0 release
```

### Representative and contiguous profiles

These two profiles are diagnostic selections for the current `wbr_2026` ELF. They are not target-specific behavior in Cortex Kit:

- `representative` selects up to eight leaves such as `SysTime.ms`, `SysTime.us`, `pendulum_debug.thread_time`, `pendulum_debug.pitch`, `pendulum_debug.yaw`, `debug_ins.accel[0]`, `debug_ins.accel[1]`, and `debug_temp`. Their addresses are dispersed and therefore require several memory transactions per frame.
- `contiguous` selects adjacent `pendulum_debug` floating-point members from `alphal_eq` through `xref`. The worker can merge them into a much smaller number of block reads.

If none of the preferred names exists, the harness falls back to a few addressable RAM scalars. If only some preferred names exist, it tests those and reports the resulting `channelCount`; inspect `variables[].address` before comparing runs. To test the contiguous profile:

```powershell
node tests\hardware-dap-smoke.mjs `
  "D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf" `
  "STLink V2-1,SN:<ST-LINK-SERIAL>" `
  2 4000 false false false 5000 contiguous 8 "" 0 release
```

`variables[].observedSamplesPerSecond` is calculated from received samples divided by wall-clock collection time. `reportedBatchSamplePeriodNs` and `reportedBatchSamplesPerSecond` come from the most recent backend batch. `droppedFrames` counts samples rejected by a bounded worker or transport queue; zero does not mean that the requested rate was reached.

### Source breakpoint smoke test

Pass a source path and one-based line number as argument 11. The harness installs the breakpoint while the program is running, checks that it resolves, waits for a standard DAP `stopped` event with reason `breakpoint`, removes the breakpoint, and continues the target:

```powershell
node tests\hardware-dap-smoke.mjs `
  "D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf" `
  "STLink V2-1,SN:<ST-LINK-SERIAL>" `
  0.5 4000 false false false 500 representative 1 `
  "D:\Workspace\robomaster\wbr_2026\User\Task\Src\TaskPendulum.cpp:224" 0 release
```

The `sourceBreakpoint` result records the requested and resolved lines, instruction address, elapsed time from `setBreakpoints` to the stop event, and continue response time. Choose a line that the running firmware reaches regularly; a timeout alone does not show that breakpoint programming failed.

### Direct acquisition benchmark

Argument 12 runs `cortexKit/benchmark` against the active subscriptions after the streamed collection interval. Leave argument 11 empty when no source breakpoint is needed:

```powershell
node tests\hardware-dap-smoke.mjs `
  "D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf" `
  "STLink V2-1,SN:<ST-LINK-SERIAL>" `
  0.5 4000 false false false 5000 contiguous 8 "" 0.75 release
```

The benchmark result contains:

- `requestedSamplesPerSecond`: requested complete frames per second.
- `actualSamplesPerSecond`: completed benchmark reads divided by benchmark duration.
- `meanIntervalMicros`, `p95IntervalMicros`, and `p99IntervalMicros`: latency distribution for complete read/decode iterations. Lower values indicate more headroom and a tighter distribution.
- `readErrors`: failed acquisition iterations. Inspect adapter stderr and probe connection quality when nonzero.

The direct benchmark requests one frame per worker call. At a requested rate of 5 kS/s, normal streaming requests ten frames per call, so its observed rate can be higher by amortizing command and scheduling overhead. Compare like with like and do not substitute the direct benchmark rate for `variables[].observedSamplesPerSecond`.

### STM32H723 and ST-Link reference run

One development run used an STM32H723VGT6 board, the probe-rs target `STM32H723VG`, an ST-Link V2-1, SWD at 4 MHz, and the existing `wbr_2026` debug-symbol ELF. The final streamed and direct acquisition measurements used `backendProfile=release`, which is the optimized adapter embedded in the packaged VSIX. The firmware did not contain a Cortex Kit target-side recorder. These values describe this board, probe, firmware state, host load, and adapter revision; they are diagnostic reference points rather than performance guarantees.

| Check | Result from this run |
| --- | --- |
| Flash, verify, reset | Completed through Cortex Kit in about 16.6 seconds. |
| ELF catalog | 235 root variables and 31,513 addressable scalar leaves. |
| Structure/array DWARF | `SysTime.ms`, `pendulum_debug.thread_time`, and `debug_ins.accel[0]` resolved as independently plottable leaves. |
| Pause/register/continue | Final Release run paused in 4.31 ms and resumed in 9.88 ms, with 20 CPU registers and a valid PC returned; repeated runs varied up to about 32 ms. |
| Streamed, contiguous 8, requested 5 kS/s, Release backend | 2.013 s, 2,660 samples per channel, about 1,321.29 frames/s observed; last batch reported about 1,251.42 frames/s; zero dropped frames. |
| Streamed, representative 8, requested 5 kS/s, Release backend | 2.007 s, 780 samples per channel, about 388.66 frames/s observed; last batch reported about 423.47 frames/s; zero dropped frames. |
| Direct benchmark, contiguous 8, 0.75 s, Release backend | 680.00 frames/s; mean 1,472.70 us, p95 1,783.90 us, p99 2,308.30 us; zero read errors. |
| Direct benchmark, representative 8, 0.75 s, Release backend | 289.33 frames/s; mean 3,460.02 us, p95 4,420.70 us, p99 6,126.50 us; zero read errors. |
| Source breakpoint | `TaskPendulum.cpp:224` resolved to `0x0801e41a`; repeated runs stopped in about 32–145 ms and resumed in about 13–20 ms. |

The run confirms end-to-end flashing, DWARF structure and array expansion, plotting transport, pause/register/continue synchronization, and a source breakpoint on this target. It also shows that address layout dominates host-driven SWD sampling: eight adjacent 32-bit values were over three times faster than the representative dispersed set, but neither reached the requested 5 kS/s. The requested rate is a scheduling target, while the observed and reported rates show what the complete hardware path achieved. A flat plot can still be valid target data: in this firmware run `SysTime` and `pendulum_debug.thread_time` changed, while several pitch, yaw, and acceleration fields remained zero during the observation window.
