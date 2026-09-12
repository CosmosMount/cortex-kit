# Architecture

Cortex Kit is a new extension with its own protocol and project structure. MemRW3 supplied the design reference for the Rust data path, DWARF/SVD/FFT separation, and single-owner ProbeWorker. Cortex-Debug supplied only examples of VS Code interaction patterns.

```mermaid
flowchart LR
    VS[VS Code Debug UI] <-->|DAP over stdio| DAP[cortex-kit-dap]
    Trees[Variables / Peripherals / Session] <-->|custom DAP events| DAP
    Plot[Plots Webview] <-->|VS Code messages| Ext[TypeScript extension]
    DAP -->|port and token| Ext
    DAP -->|binary sample batches| Ext
    Ext --> Plot
    DAP --> Worker[ProbeWorker]
    Worker --> Mock[Mock backend]
    Worker --> Probe[probe-rs backend]
    Probe --> ST[ST-Link]
    Probe --> CMSIS[CMSIS-DAP / DAPLink]
```

The `cortex-kit-core` crate owns serializable state, ELF symbol and DWARF line metadata, SVD parsing, the expression engine, read planning, bounded buffers, and FFT. `cortex-kit-probe` owns probe-rs sessions and serializes every hardware operation on one thread. `cortex-kit-dap` implements Debug Adapter Protocol framing and the independent sample server. The TypeScript extension owns VS Code commands and native trees. `webview-ui` owns chart layout and rendering.

Live Watch and Plot keep separate persisted variable selections. Plot dependencies form the high-rate Worker subscription; watch-only variables form a separate background subscription (20 S/s by default), even while Plot is active. Shared variables use the Plot samples without a second read. Both groups run on the same serialized Worker and emit independent real sample batches with their own measured timing. Background values are never repeated into Plot frames. Plot expressions are evaluated only on Plot batches. The native Live Watch tree separately throttles its UI refresh. With no plotted variables, the foreground subscription itself runs at the configured Live Watch rate.

Subscription changes and typed writes are short target transactions. If the target is running, the DAP layer sends an urgent halt, performs the subscription update or typed memory write, and restores the running state even when the operation reports an error. A typed write also flushes probe-side batching and reads the bytes back before resume. Unchanged subscription sets are cached in the extension, so chart reordering, chart mode changes, and Webview reloads do not repeatedly pause the target.

The Worker has separate urgent and normal queues. Disconnect, pause, reset, and stepping enter the urgent queue. Acquisition checks commands every 2 ms. A real acquisition burst borrows `Core` once, performs merged RAM block reads, decodes every subscribed variable, and drops the lexical borrow before another command can flash, reset, or disconnect. Peripheral and special regions are always isolated. There is no `Core<'static>` conversion and no unsafe code in Cortex Kit.

Every state update carries `sessionId`, `programGeneration`, `streamEpoch`, `stopId`, and `revision`. Continue increments the stream epoch; pause/reset close the current stream and increment the stop ID; flash increments the program generation. The extension rejects sample batches whose identifiers differ from the current state, so a delayed frame cannot contaminate a new firmware or stream segment.

DAP carries control and low-rate snapshots. Samples use an authenticated loopback TCP connection announced through a custom DAP event. Each binary frame contains a magic value and protocol version followed by session/program/stream identifiers, sequence and timing fields, dropped-frame count, channel identifiers, and interleaved `f64` values. The data server aggregates the Worker's short bursts into approximately 10 ms transmissions.

Chip differences enter through the probe-rs registry, target YAML support in probe-rs, ELF/DWARF, and SVD. No STM32H723VGT6 condition appears in the product code. With probe-rs 0.31, the built-in target selected for STM32H723VGT6 is `STM32H723VG`.
