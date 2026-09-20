# ST-Link validation with `robomaster/pnx_template`

Date: 2026-09-18

## Firmware and target

- Source tree: `D:\Workspace\robomaster\pnx_template`
- Source revision: `237b4a2f3baf` (clean working tree)
- Preset: `h723-debug`
- ELF: `D:\Workspace\robomaster\pnx_template\build\h723-debug\pnx_embedded.elf`
- ELF SHA-256: `6F1BEEFC897C8AED803E6D80CFE341616B0EC2EC14E546597B1BC55E22C93087`
- ELF timestamp: 2026-09-18 17:38:49
- Target: STM32H723VG, `SystemCoreClock = 520000000`
- Probe: STLink V2-1, serial `00400038480000014E575152`, SWD 4000 kHz

The firmware was configured with `cmake --preset h723-debug`, built with
`cmake --build --preset h723-debug --parallel 1`, flashed through Cortex Kit with
verify and reset enabled, and then sampled while the target remained running.
The flash operation completed successfully and Cortex Kit reported program
generation 1.

## Results

All workloads requested 5000 samples/s. Streamed rates are measured end to end
through the native adapter and binary data channel. Direct rates isolate repeated
Rust backend reads.

| Workload | Duration | Streamed rate | Direct rate | Direct mean / p95 / p99 | Errors / drops |
| --- | ---: | ---: | ---: | ---: | ---: |
| IMU fields, 8 contiguous floats | 10 s | 613.27 S/s | 634 S/s | 1577.95 / 2028.2 / 2793.7 us | 0 / 0 |
| IMU fields, 8 contiguous floats | 30 s | 597.74 S/s | 622.4 S/s | 1606.83 / 2185.9 / 3292.2 us | 0 / 0 |
| Generic contiguous, 32 x 4 B | 5 s | 374.44 S/s | 388 S/s | 2584.58 / 3261.6 / 4122.1 us | 0 / 0 |
| Generic contiguous, 64 x 4 B | 5 s | 252.70 S/s | 268 S/s | 3741.83 / 4328.9 / 6726.5 us | 0 / 0 |
| Generic dispersed, 16 x 4 B | 5 s | 119.33 S/s | 124 S/s | 8056.91 / 9486.4 / 10272.7 us | 0 / 0 |
| Generic dispersed, 32 x 4 B | 5 s | 61.76 S/s | 65 S/s | 15393.93 / 17066.7 / 18309.4 us | 0 / 0 |
| IMU fields, 8 contiguous floats, 16 ms batching | 10 s | 1197.62 S/s | 603.5 S/s (single-read benchmark) | 1658.00 / 2247.0 / 3066.7 us | 0 / 0 |
| Generic contiguous, 64 x 4 B, 16 ms batching | 5 s | 325.20 S/s | 266 S/s (single-read benchmark) | 3760.35 / 4432.0 / 5921.5 us | 0 / 0 |
| Generic dispersed, 32 x 4 B, 16 ms batching | 5 s | 62.74 S/s | 63.5 S/s | 15776.25 / 17207.9 / 19702.8 us | 0 / 0 |

The 30-second run collected 17,935 samples per IMU channel. Pause/resume and
register/peripheral inspection also passed; pause response was 6.26 ms.

After the 16 ms batching change and legacy-path removal, the final 30-second run
collected 35,829 samples per IMU channel (1193.72 S/s), with zero errors and zero
dropped frames. The single-read benchmark was 606.6 S/s; batching nearly doubled
the end-to-end rate by reusing one Core handle across several reads. Pause
response was 12.57 ms.

Raising the adaptive acquisition-call budget from 2 ms to 16 ms lets one
probe-rs Core handle serve several consecutive frames. On the same 8-channel
IMU workload this raised streamed throughput from 613.27 S/s to 1197.62 S/s
(about 95%), while the 64-channel contiguous workload rose from 252.70 S/s to
325.20 S/s (about 29%). The dispersed 32-channel workload remained transaction
bound at about 63 S/s. Pause response remained below 21 ms in these stress runs.

## Read-block A/B

For the same contiguous 64-channel workload, reducing the maximum merged RAM
block from 256 B to 128 B reduced direct throughput from 268 S/s to 240 S/s and
streamed throughput from 252.70 S/s to 239.95 S/s. Cortex Kit therefore keeps the
256 B maximum. Splitting an already contiguous region adds a probe transaction
and is slower on this ST-Link setup.

## Interpretation

Address layout and probe transaction count dominate throughput. The dispersed
32-channel workload takes about twice as long per frame as dispersed 16, while a
single contiguous block is several times faster. The Rust core now caches the
read plan and buffers, merges normal RAM reads up to 256 B with a 32 B gap limit,
and uses a high-resolution acquisition deadline on Windows. Further gains will
most likely require fewer/larger probe transactions, a lower-overhead ST-Link
transport path, or firmware-provided packed telemetry rather than more
TypeScript-side processing.

The sampled `demo_debug_instance.imu_unit` quaternion was the identity and its
angles remained zero during these runs. Other live firmware counters changed,
so the target was running and memory acquisition was live. This measurement
validates Cortex Kit transport stability and rate, but does not by itself verify
that this firmware path is updating the selected AHRS output fields.

Raw evidence is stored beside this report in `stlink-pnx-*.json`; the exact IMU
selection is in `pnx-imu-8-selection.json`.
