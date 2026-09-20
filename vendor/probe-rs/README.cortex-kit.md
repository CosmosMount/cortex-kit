# Cortex Kit probe-rs fork

This directory vendors the published `probe-rs` 0.31.0 crate from crates.io.
The upstream source revision recorded by that crate is
`4f008cdf4829e6e2004eb1facb4e553f76ead6ed`.

Cortex Kit carries a focused CMSIS-DAP transaction patch that:

- combines pending AP setup writes and small block transfers in one
  `DAP_Transfer` packet;
- batches scattered 32-bit TAR/DRW pairs within the probe packet limit; and
- retains the default per-address fallback for non-CMSIS-DAP probes and
  addresses above 32 bits.

The fork remains licensed as `MIT OR Apache-2.0`; this vendored copy is
distributed under the included `LICENSE-MIT` terms.
