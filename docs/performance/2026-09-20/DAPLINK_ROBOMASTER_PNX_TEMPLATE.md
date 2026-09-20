# DAPLink stress test with `robomaster/pnx_template`

Date: 2026-09-20

## Setup

- Firmware source: `D:\Workspace\robomaster\pnx_template`
- Source revision: `237b4a2f3baf`
- ELF: `D:\Workspace\robomaster\pnx_template\build\h723-debug\pnx_embedded.elf`
- ELF SHA-256: `6F1BEEFC897C8AED803E6D80CFE341616B0EC2EC14E546597B1BC55E22C93087`
- Target: STM32H723VG
- Probe: Horco CMSIS-DAP, serial `343420334503`
- Stable requested SWD clock: 10000 kHz
- Backend: Cortex Kit 1.1.0 Release, Rust-only data path, 32 ms adaptive acquisition-call budget, 4 KiB maximum normal-RAM plan block

The ELF was flashed through this DAPLink probe with verification and reset
enabled. Flashing succeeded, `programGeneration` advanced to 1, the target ran,
the ELF catalog contained 16,919 scalar leaves, and the target identification
register was `0x10016483`.

## Baseline stress matrix

These baseline runs used the earlier 16 ms adaptive acquisition-call budget.

All runs requested 5000 samples/s. Streamed rate is the end-to-end rate through
the DAP server and binary sample channel. Direct rate repeatedly invokes the
Rust probe backend without the stream transport. All successful cases completed
with zero read errors and zero dropped frames.

| Workload | Duration | Streamed rate | Direct rate | Direct p95 | Pause response |
| --- | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 contiguous floats, flash/verify run | 5 s | 193.64 S/s | 125.0 S/s | 11.26 ms | 44.46 ms |
| IMU, 8 contiguous floats, stability run | 30 s | 180.38 S/s | 123.2 S/s | 12.54 ms | 33.20 ms |
| Generic contiguous, 32 x 4 B | 5 s | 79.59 S/s | 83.5 S/s | 16.28 ms | 27.43 ms |
| Generic contiguous, 64 x 4 B | 5 s | 59.35 S/s | 63.5 S/s | 22.40 ms | 34.97 ms |
| Generic dispersed, 16 x 4 B | 5 s | 30.95 S/s | 34.5 S/s | 33.54 ms | 45.56 ms |
| Generic dispersed, 32 x 4 B | 5 s | 16.79 S/s | 18.0 S/s | 68.71 ms | 96.26 ms |

The 30-second run collected 5,414 samples per IMU channel without an error or
drop. Its quaternion remained the identity and the selected angles remained
zero, consistent with the earlier ST-Link observation for these firmware fields.

## Adaptive-batch optimization

The acquisition-call budget was tested at 16, 32, and 64 ms with three 8-second
IMU8 runs per setting. The budget controls how many real target reads are made
while one Rust backend call owns the probe; it does not duplicate or interpolate
samples.

| Budget | Mean streamed rate | Median streamed rate | Median pause response | Errors / drops |
| ---: | ---: | ---: | ---: | ---: |
| 16 ms | 179.62 S/s | 180.57 S/s | 31.77 ms | 0 / 0 |
| 32 ms | 236.56 S/s | 234.77 S/s | 49.93 ms | 0 / 0 |
| 64 ms | 239.03 S/s | 238.81 S/s | 62.61 ms | 0 / 0 |

The 32 ms setting improves the median IMU8 rate by 30.0% over 16 ms. Moving to
64 ms adds only 1.7% more throughput while increasing command latency, so 32 ms
is retained as the default.

Final 32 ms validation used the same probe, ELF, 10 MHz requested SWD clock, and
5000 S/s request:

| Workload | Duration | Streamed rate | Direct rate | Direct p95 | Pause response |
| --- | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 contiguous floats | 30 s | 233.63 S/s | 120.5 S/s | 12.31 ms | 53.97 ms |
| Generic contiguous, 32 x 4 B | 10 s | 111.95 S/s | 82.5 S/s | 16.72 ms | 40.93 ms |
| Generic dispersed, 32 x 4 B | 10 s | 17.08 S/s | 18.0 S/s | 61.74 ms | 77.25 ms |

The 30-second optimized run collected 7,010 real samples per IMU channel with
zero read errors and zero dropped frames. Relative to the 16 ms runs, contiguous
32-channel throughput improved by 40.7%, while dispersed 32-channel throughput
improved by only 1.7%.

### Large contiguous blocks

The earlier 256-byte planner cap caused extra outer reads even though probe-rs
already splits transfers at the ARM MEM-AP auto-increment boundary. Raising the
bounded plan block first to 1 KiB produced these single-run results:

| Channels | 256 B block | 1 KiB block | Change | 256 B / 1 KiB pause |
| ---: | ---: | ---: | ---: | ---: |
| 128 contiguous | 31.63 S/s | 36.81 S/s | +16.4% | 54.48 / 43.80 ms |
| 256 contiguous | 18.32 S/s | 21.62 S/s | +18.0% | 82.40 / 55.37 ms |

At 512 contiguous channels, three runs per setting compared the 1 KiB and 4 KiB
caps. The 4 KiB cap raised median throughput from 9.99 to 10.73 S/s (+7.4%),
raised mean direct-read throughput from 10.50 to 11.33 S/s, reduced mean direct
p95 from 107.06 to 101.97 ms, and reduced median pause response from 119.98 to
102.90 ms. The final implementation therefore uses a bounded 4 KiB plan while
leaving the hardware-boundary splitting to probe-rs.

After all rejected experiments were reverted and legacy code was removed, a
fresh build of the final source completed these confirmation runs:

| Final workload | Duration | Streamed rate | Direct rate | Direct p95 | Pause response | Errors / drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 contiguous floats | 30 s | 242.16 S/s | 128.0 S/s | 11.57 ms | 41.81 ms | 0 / 0 |
| Generic contiguous, 512 x 4 B | 10 s | 10.98 S/s | 11.5 S/s | 95.77 ms | 96.72 ms | 0 / 0 |

The final IMU run collected 7,268 real samples per channel.

## CMSIS-DAP transaction optimization

Inspection of probe-rs 0.31.0 showed that a small memory read first flushed its
pending AP configuration/TAR writes with `DAP_Transfer`, then issued a separate
`DAP_TransferBlock`. The retained fork combines those operations in one packet
when they fit. It also batches exact 32-bit scattered reads as TAR/DRW pairs,
bounded by both request and response capacity. Other debug-probe backends use
the original default path, and addresses above 32 bits conservatively fall back
to ordinary reads.

Three matched 8-second runs before and after the transaction change produced:

| Workload | Before mean | After mean | Change | After direct mean | Errors / drops |
| --- | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 contiguous floats | 236.56 S/s | 394.36 S/s | +66.7% | 144.17 S/s | 0 / 0 |
| Generic dispersed, 32 x 4 B | 17.08 S/s | 87.22 S/s | 5.1x | 73.17 S/s | 0 / 0 |

The final source and vendored dependency then completed longer release tests:

| Final workload | Duration | Streamed rate | Direct rate | Direct p95 | Pause response | Samples/channel | Errors / drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 contiguous floats | 30 s | 371.78 S/s | 142.0 S/s | 10.39 ms | 46.33 ms | 11,160 | 0 / 0 |
| Generic dispersed, 32 x 4 B | 30 s | 83.65 S/s | 69.0 S/s | 20.18 ms | 49.09 ms | 2,510 | 0 / 0 |
| Generic dispersed, 64 x 4 B | 10 s | 43.06 S/s | 49.0 S/s | 27.69 ms | 39.69 ms | 431 | 0 / 0 |

A same-value write test automatically halted the running target, combined the
write transaction, verified the readback, and resumed execution. The target
finished running with zero read errors and zero dropped frames.

The 64-channel scaling result is consistent with the remaining hard limit: the
probe reports a 64-byte CMSIS-DAP packet, so only a bounded number of TAR/DRW
pairs fit per USB round trip. Further host-side compression would require
unsafe read reordering, request pipelining support in the probe firmware, or a
larger packet transport; none was retained without matching hardware evidence.

## Rejected changes

- Reusing a `u32` read buffer to bypass probe-rs's byte-buffer allocation gave
  236.81 S/s mean versus 236.56 S/s for the retained byte path, while median and
  direct rates did not improve. The extra decoder complexity was removed.
- Extending running-state polling from 100 to 200 ms gave only 0.7-1.1% more
  throughput and would double worst-case spontaneous breakpoint/watchpoint
  discovery latency. The 100 ms poll remains.

## Clock-limit test

Requested clocks of 12000, 15000, 20000, and 50000 kHz all failed during attach
with `Arm(Dap(NoAcknowledge))`. The complete workload passed at 10000 kHz. A
CMSIS-DAP requested clock is an upper-bound request rather than proof of the
physical waveform, so 10 MHz is recorded only as the highest verified stable
request on this probe/target/wiring combination.

After the failed high-clock attempts, a final 10 MHz recovery run passed at
186.07 S/s with zero errors and zero drops, confirming that neither the probe nor
the running target was left in a failed state.

## Comparison and bottleneck

Using the same firmware and IMU selection, the final ST-Link 8-channel run
reached 1193.72 S/s versus the optimized DAPLink long-run result of 371.78 S/s.
The remaining gap is about 3.2x, reduced from about 6.6x before transaction
batching. The DAPLink scatter path is no longer dominated by one host round trip
per address, but throughput still falls as 64-byte reports require additional
packets.

The dominant remaining limit is CMSIS-DAP packet capacity, synchronous USB
round trips, and probe firmware execution rather than TypeScript or Rust signal
processing. The most effective next steps are a larger-packet/high-speed
CMSIS-DAP implementation, verified request pipelining in probe firmware, packed
firmware telemetry, or selecting contiguous fields.

Representative raw JSON results are stored beside this report as
`daplink-pnx-*.json`, `daplink-opt-*.json`, and
`daplink-transaction-final-*.json`.
