# WBR 2026 mixed-rate acquisition, 2026-09-12

## Outcome

The installed 0.1.1 adapter delivered **1003.19 Plot samples/s per channel** with four Plot variables and 19 watch-only variables over 15 seconds. Watch-only channels delivered **17.99 samples/s** at a requested 20 S/s. The run reported zero dropped frames and no adapter read error. It read the existing STM32H723VG firmware through ST-Link V2-1 (serial 00220015480000014E575152), requesting SWD 10000 kHz; probe firmware may negotiate a lower supported clock. No firmware flashing, reset, or variable write was performed. Subscription changes briefly halt/resume as before.

## Workload and comparison

The saved Plot selection was `SysTime.s`, `SysTime.ms`, `SysTime.us`, and `pendulum_debug.thread_time`. Workspace storage contained 56 Live Watch fields rather than the 19 mentioned in the request. The 19-field workload uses the first 19 saved `pendulum_debug` fields; it is a reproducible representative workload, not a claim to have recovered the current unsaved 19 selections. Exact IDs are checked into the JSON fixtures beside these measurements. All four Plot values are acquired in every foreground frame; shared `thread_time` is deduplicated in the 56-watch case.

| Adapter / workload | Plot requested S/s | Plot observed S/s | Watch observed S/s | Collection |
| --- | ---: | ---: | ---: | ---: |
| Installed original, 19 watch + 4 Plot, merged | 1000 | 320.53 | 320.53 | 8 s |
| Installed original, 19 watch + 4 Plot, merged | 5000 | 338.32 | 338.32 | 8 s |
| Optimized release, 19 watch + 4 Plot, separate rates | 1000 | 396.77 | 18.10 | 8 s |
| Installed optimized 0.1.1, 19 watch + 4 Plot | 5000 | 1003.19 | 17.99 | 15 s |
| Installed original, saved 56 watch + 4 Plot | 1000 | 244.40 | 244.40 | 8 s |
| Optimized release, saved 56 watch + 4 Plot | 5000 | 959.37 | 18.24 | 8 s |

The final 19-watch run is 3.13 times the original at 1000 requested S/s, and 2.97 times the original at the same 5000 requested S/s. Earlier optimized runs were around 917–959 S/s; host scheduling and USB load affect results. These are hardware-path measurements using the same DAP and binary transport as VS Code, not a measurement of Webview render FPS. 5000 S/s remains a request, not an achieved hardware rate.

## Changes

- Plot raw dependencies stay in the foreground subscription. Live Watch-only variables use `backgroundIds` and `backgroundSamplesPerSecond` (20 by default).
- The single-owner Worker schedules real reads for both groups, emits separate timestamped batches, and removes shared channels from the background group. Background samples are never copied into high-rate frames.
- Low-rate foreground subscriptions now respect their requested interval instead of being sampled every 2 ms. High-rate acquisition retains bursts to amortize host/probe overhead.
- The Webview receives Plot batches only, so background frames cannot inject incomplete expression samples. Live Watch UI refresh throttling is independent of acquisition.
- The WBR Live Plot attach configuration was updated from 1000 to 5000 requested S/s. Other launch settings were preserved.

## Validation and installation

37 Rust tests, 16 TypeScript tests, and the Mock DAP smoke test passed. Worker coverage checks independent rates, monotonic channel timing, shared-channel deduplication, pause, and transition back to Live Watch-only acquisition. The final hardware run checked pause (8.8 ms), 20 CPU registers, a peripheral register read, and resume (7.68 ms), then disconnected cleanly. A later attempt to repeat the full 56-watch workload could not reopen the USB device (error code 5); no reset or forced process termination was attempted. The successful 56-watch results above were obtained earlier.

Version 0.1.1 was installed into the existing **Cortex Kit** VS Code profile using a compatibility VSIX retaining publisher `cortex-kit`, so its existing workspace selections remain under the same extension ID. The installed backend SHA-256 matches the release build: `c96d40a20e54650148b55cc9326a917d8664b18eaf7d71dbcc0506a051dbc513`. Reload VS Code to activate the new extension host, then start **Cortex Kit: Live Plot (Attach)**. The regular `CosmosMount` publisher VSIX is also built; use the legacy compatibility package to update the existing local installation without changing its identity.

## Reproduction

From the repository root in PowerShell (close the active debug session before opening the probe):

```powershell
$env:CORTEX_KIT_SELECTION = "$PWD\docs\performance\2026-09-12\selection-19-split.json"
node tests/hardware-dap-smoke.mjs D:\Workspace\robomaster\wbr_2026\build\Debug\wbr_chassis.elf auto 15 10000 false false false 5000 representative 8 '' 0 release false
```

The JSON result's per-variable `observedSamplesPerSecond` is the comparison metric. The top-level last-batch rate may describe either group. The original launch file and executable are retained in the ignored `.tmp` directory for local rollback.
