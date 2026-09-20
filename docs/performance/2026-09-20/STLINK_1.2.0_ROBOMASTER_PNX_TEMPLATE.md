# ST-Link 1.2.0 performance validation

## Scope

- Target: STM32H723VG running `D:\Workspace\robomaster\pnx_template\build\h723-debug\pnx_embedded.elf`
- Probe: STLink V2-1, serial `00400038480000014E575152`
- Transport: SWD
- Backend: optimized release build
- Requested acquisition rate: 5000 samples/s per channel
- Final negotiated debug clock: 4600 kHz

The final 30 second run flashed and verified the exact ELF above before sampling.
It also verified a same-value write while the target was running and confirmed that
the adapter automatically resumed the target.

## Results

| Workload | 1.1.0 baseline | 1.2.0 final | Change | Read errors | Dropped frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| IMU, 8 selected channels | 1217.85 S/s | 1754.42 S/s | +44.1% | 0 | 0 |
| Dispersed RAM, 32 channels | 62.16 S/s | 84.08 S/s | +35.3% | 0 | 0 |
| Contiguous RAM, 64 channels | 337.72 S/s | 540.74 S/s | +60.1% | 0 | 0 |

The baseline requested 4000 kHz. ST-Link V2-1 supports discrete rates and
probe-rs selected 1800 kHz for that request. The final configuration requests
4600 kHz and now reports the negotiated 4600 kHz value in session state instead
of leaving the effective clock implicit.

The final IMU run collected 52,654 samples per channel over 30.012 seconds.
Its direct single-frame benchmark reached 759.4 S/s with a 1316.73 microsecond
mean interval, 1777.1 microsecond p95, and 2619.7 microsecond p99. Streamed
sampling is faster because adaptive multi-frame calls amortize probe-rs core
acquisition, allocation, event dispatch, and binary framing overhead.

## Retained optimizations

1. The high-rate worker may request up to one batch per 125 requested samples,
   while the existing measured 32 ms call budget remains the adaptive limit.
   On the 8-channel workload this raised the stable streamed rate without
   exceeding the intended interactive latency envelope.
2. ST-Link one-word reads use a stack buffer instead of allocating a heap
   vector for every scattered telemetry word. The ST-Link command and final
   read/write status check remain unchanged.
3. The effective probe clock returned by probe-rs is included in the probe name
   exposed through session state, making future measurements auditable.

## Rejected experiments

- Increasing the ordinary-RAM merge gap was rejected. In the 32-channel test,
  thresholds from 32 through 192 bytes produced the same 32 blocks. At 256
  bytes, the planner reduced the block count to 24 but expanded transferred data
  from 128 bytes to 2136 bytes and throughput fell sharply. Peripheral and
  special-memory reads remain isolated.
- Increasing target-state polling from 100 ms to 250 ms changed throughput by
  only 0.08% while increasing halt-detection latency, so 100 ms was restored.
- A more aggressive batch request limit improved throughput by only 0.22% but
  pushed pause-event latency from 28.23 ms to 35.14 ms, so the lower limit was
  retained.
- Skipping ST-Link's final read/write status command was not attempted because
  it would trade error detection for misleading benchmark speed.

## Remaining bottleneck

For dispersed addresses, ST-Link V2-1 still needs a separate proprietary memory
read plus a status transaction for each address. Unlike the CMSIS-DAP path, it
cannot batch arbitrary TAR/DRW address pairs into one probe packet. The practical
ways to go faster are therefore to select contiguous telemetry, expose a packed
firmware telemetry structure, or use a probe/transport with efficient scattered
AP batching. The 64-channel contiguous result demonstrates the benefit of that
layout.

## Evidence

- `stlink-1.2-baseline-imu8-10s.json`
- `stlink-1.2-baseline-scatter32-10s.json`
- `stlink-1.2-baseline-contiguous64-10s.json`
- `stlink-1.2-final-flash-imu8-30s.json`
- `stlink-1.2-final-scatter32-12s.json`
- `stlink-1.2-final-contiguous64-12s.json`
