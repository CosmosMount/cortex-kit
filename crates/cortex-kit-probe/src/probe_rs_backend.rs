use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
    time::Duration,
};

use cortex_kit_core::{MemoryClass, ReadRequest, ScalarKind, TargetState, plan_reads};
use probe_rs::{
    CoreStatus, HaltReason, MemoryInterface, Session,
    flashing::{BinOptions, DownloadOptions, Format, download_file_with_options},
    probe::{WireProtocol, list::Lister},
};
use probe_rs_debug::DebugRegisters;

use crate::{Backend, Breakpoint, ProbeConfig, ProbeInfo, RegisterValue, StepKind, WatchSpec};

const MAX_NORMAL_RAM_GAP: usize = 32;
// probe-rs splits at the ARM MEM-AP 1 KiB auto-increment boundary. A bounded
// 4 KiB plan avoids repeated outer calls and allocations across those chunks.
const MAX_NORMAL_RAM_BLOCK: usize = 4096;

pub fn list_probes() -> Vec<ProbeInfo> {
    Lister::new()
        .list_all()
        .into_iter()
        .map(|probe| {
            let selector = format!(
                "{},SN:{}",
                probe.identifier,
                probe.serial_number.as_deref().unwrap_or("N/A")
            );
            let probe_type = format!("{:?}", probe.probe_type());
            ProbeInfo {
                selector,
                identifier: probe.identifier,
                serial_number: probe.serial_number,
                probe_type,
            }
        })
        .collect()
}

pub fn list_targets() -> Vec<String> {
    let mut targets = probe_rs::config::Registry::from_builtin_families()
        .families()
        .iter()
        .flat_map(|family| family.variants.iter().map(|variant| variant.name.clone()))
        .collect::<Vec<_>>();
    targets.sort();
    targets.dedup();
    targets
}

#[derive(Default)]
pub struct ProbeRsBackend {
    session: Option<Session>,
    name: String,
    installed_breakpoints: BTreeSet<u64>,
    read_plan: Option<CachedReadPlan>,
}

struct CachedReadBlock {
    address: u64,
    byte_len: usize,
    mappings: Vec<(usize, usize, u8, ScalarKind)>,
    scatter_slot: Option<usize>,
}

struct CachedReadPlan {
    watches: Vec<WatchSpec>,
    blocks: Vec<CachedReadBlock>,
    scatter_addresses: Vec<u64>,
    scatter_values: Vec<u32>,
    scratch: Vec<u8>,
    frame: Vec<f64>,
}

impl CachedReadPlan {
    fn new(watches: &[WatchSpec]) -> Self {
        let requests = watches
            .iter()
            .map(|watch| ReadRequest {
                variable_id: watch.id.clone(),
                address: watch.address,
                byte_width: watch.byte_width,
                memory_class: classify_address(watch.address),
            })
            .collect::<Vec<_>>();
        let channels = watches
            .iter()
            .enumerate()
            .map(|(index, watch)| (watch.id.as_str(), (index, watch.scalar_kind)))
            .collect::<HashMap<_, _>>();
        let mut blocks = plan_reads(&requests, MAX_NORMAL_RAM_GAP, MAX_NORMAL_RAM_BLOCK)
            .into_iter()
            .map(|block| CachedReadBlock {
                address: block.address,
                byte_len: block.byte_len,
                mappings: block
                    .variables
                    .into_iter()
                    .filter_map(|mapping| {
                        channels
                            .get(mapping.variable_id.as_str())
                            .map(|(channel, kind)| {
                                (*channel, mapping.offset, mapping.byte_width, *kind)
                            })
                    })
                    .collect(),
                scatter_slot: None,
            })
            .collect::<Vec<_>>();
        let mut scatter_addresses = Vec::new();
        for block in &mut blocks {
            if block.byte_len == 4 {
                block.scatter_slot = Some(scatter_addresses.len());
                scatter_addresses.push(block.address);
            }
        }
        let scatter_values = vec![0; scatter_addresses.len()];
        let scratch = vec![0; blocks.iter().map(|block| block.byte_len).max().unwrap_or(0)];
        Self {
            watches: watches.to_vec(),
            blocks,
            scatter_addresses,
            scatter_values,
            scratch,
            frame: vec![f64::NAN; watches.len()],
        }
    }
}

impl Backend for ProbeRsBackend {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn connect(&mut self, config: &ProbeConfig) -> Result<(), String> {
        self.disconnect();
        let protocol = match config.protocol.to_ascii_lowercase().as_str() {
            "swd" => WireProtocol::Swd,
            "jtag" => WireProtocol::Jtag,
            other => return Err(format!("unsupported protocol: {other}")),
        };
        let probes = Lister::new().list_all();
        let info = match &config.selector {
            Some(selector) if selector != "auto" => probes
                .into_iter()
                .find(|probe| {
                    format!(
                        "{},SN:{}",
                        probe.identifier,
                        probe.serial_number.as_deref().unwrap_or("N/A")
                    ) == *selector
                })
                .ok_or_else(|| "selected probe is no longer connected".to_owned())?,
            _ => probes
                .into_iter()
                .next()
                .ok_or_else(|| "no ST-Link or CMSIS-DAP probe found".to_owned())?,
        };
        self.name = format!(
            "{} ({})",
            info.identifier,
            info.serial_number.as_deref().unwrap_or("no serial")
        );
        let mut probe = info
            .open()
            .map_err(|error| format!("failed to open {}: {error:?}", self.name))?;
        probe
            .select_protocol(protocol)
            .map_err(|error| format!("failed to select {protocol:?}: {error:?}"))?;
        probe.set_speed(config.speed_khz).map_err(|error| {
            format!(
                "failed to set probe speed to {} kHz: {error:?}",
                config.speed_khz
            )
        })?;
        let session = if config.connect_under_reset {
            probe.attach_under_reset(config.chip.clone(), Default::default())
        } else {
            probe.attach(config.chip.clone(), Default::default())
        };
        self.session =
            Some(session.map_err(|error| {
                format_attach_failure(config, &self.name, &format!("{error:?}"))
            })?);
        Ok(())
    }
    fn target_state(&mut self) -> Result<TargetState, String> {
        let mut core = self.core()?;
        let mut status = core.status().map_err(|error| error.to_string())?;
        if status == CoreStatus::Unknown {
            status = core.status().map_err(|error| error.to_string())?;
        }
        Ok(map_core_status(status))
    }
    fn disconnect(&mut self) {
        self.installed_breakpoints.clear();
        self.read_plan = None;
        self.session = None;
    }
    fn halt(&mut self) -> Result<(), String> {
        self.core()?
            .halt(Duration::from_millis(250))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    fn resume(&mut self) -> Result<(), String> {
        let mut core = self.core()?;
        let status = core
            .status()
            .map_err(|error| format!("failed to read target state before resume: {error:?}"))?;
        match status {
            CoreStatus::Running | CoreStatus::Sleeping => Ok(()),
            _ => core
                .run()
                .map_err(|error| format!("failed to resume target from {status:?}: {error:?}")),
        }
    }
    fn reset(&mut self) -> Result<(), String> {
        self.core()?
            .reset_and_halt(Duration::from_millis(500))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    fn step(&mut self, _: StepKind) -> Result<(), String> {
        self.core()?
            .step()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    fn set_breakpoints(&mut self, breakpoints: &[Breakpoint]) -> Result<(), String> {
        let desired: BTreeSet<u64> = breakpoints.iter().map(|item| item.address).collect();
        let removed: Vec<u64> = self
            .installed_breakpoints
            .difference(&desired)
            .copied()
            .collect();
        let added: Vec<u64> = desired
            .difference(&self.installed_breakpoints)
            .copied()
            .collect();
        let mut core = self.core()?;
        let status = core.status().map_err(|error| {
            format!("failed to read target state before updating breakpoints: {error:?}")
        })?;
        let resume_after_update = matches!(status, CoreStatus::Running | CoreStatus::Sleeping);
        if resume_after_update {
            core.halt(Duration::from_millis(250)).map_err(|error| {
                format!("failed to pause target before updating breakpoints: {error:?}")
            })?;
        }
        let update_result = (|| {
            for address in removed {
                core.clear_hw_breakpoint(address).map_err(|error| {
                    format!("failed to clear hardware breakpoint at 0x{address:08x}: {error:?}")
                })?;
            }
            for address in added {
                core.set_hw_breakpoint(address).map_err(|error| {
                    format!("failed to set hardware breakpoint at 0x{address:08x}: {error:?}")
                })?;
            }
            Ok::<(), String>(())
        })();
        let resume_result = if resume_after_update {
            core.run().map_err(|error| {
                format!("failed to resume target after updating breakpoints: {error:?}")
            })
        } else {
            Ok(())
        };
        match (update_result, resume_result) {
            (Ok(()), Ok(())) => {}
            (Err(update), Ok(())) => return Err(update),
            (Ok(()), Err(resume)) => return Err(resume),
            (Err(update), Err(resume)) => {
                return Err(format!("{update}; additionally, {resume}"));
            }
        }
        drop(core);
        self.installed_breakpoints = desired;
        Ok(())
    }
    fn read_registers(&mut self) -> Result<Vec<RegisterValue>, String> {
        let mut core = self.core()?;
        core.spill_registers().map_err(|error| error.to_string())?;
        Ok(DebugRegisters::from_core(&mut core)
            .0
            .iter()
            .map(|register| RegisterValue {
                name: register.get_register_name(),
                value: register
                    .value
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "<unavailable>".into()),
            })
            .collect())
    }
    fn read_memory(&mut self, address: u64, data: &mut [u8]) -> Result<(), String> {
        self.core()?
            .read(address, data)
            .map_err(|error| error.to_string())
    }
    fn write_memory(&mut self, address: u64, data: &[u8]) -> Result<(), String> {
        let mut core = self.core()?;
        core.write(address, data)
            .map_err(|error| error.to_string())?;
        // Probe implementations may batch writes. A successful `write` only
        // means the transfer was queued; `flush` guarantees it reached the
        // target before the DAP response is sent.
        core.flush().map_err(|error| error.to_string())
    }
    fn flash(&mut self, path: &Path, verify: bool, reset_after: bool) -> Result<(), String> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "probe is not connected".to_owned())?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let format = match extension.as_str() {
            "elf" | "axf" | "out" => Format::Elf(Default::default()),
            "hex" | "ihex" => Format::Hex,
            "uf2" => Format::Uf2,
            "bin" => {
                let base_address = session
                    .target()
                    .memory_map
                    .iter()
                    .filter_map(|region| region.as_nvm_region())
                    .find(|region| region.is_boot_memory() && !region.is_alias)
                    .or_else(|| {
                        session
                            .target()
                            .memory_map
                            .iter()
                            .filter_map(|region| region.as_nvm_region())
                            .find(|region| !region.is_alias)
                    })
                    .map(|region| region.range.start)
                    .ok_or_else(|| {
                        "target has no writable NVM region for BIN base address".to_owned()
                    })?;
                Format::Bin(BinOptions {
                    base_address: Some(base_address),
                    skip: 0,
                })
            }
            _ => return Err(format!("unsupported program format: .{extension}")),
        };
        let mut options = DownloadOptions::default();
        options.verify = verify;
        download_file_with_options(session, path, format, options)
            .map_err(|error| error.to_string())?;
        if reset_after {
            session
                .core(0)
                .and_then(|mut core| core.reset())
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    fn sample(&mut self, watches: &[WatchSpec], frames: usize) -> Result<Vec<f64>, String> {
        if watches.iter().all(|watch| watch.pointer_address.is_none()) {
            return self.sample_cached(watches, frames);
        }
        let mut core = self.core()?;
        let mut pointer_values = HashMap::new();
        for address in watches.iter().filter_map(|watch| watch.pointer_address) {
            if pointer_values.contains_key(&address) { continue; }
            let mut bytes = [0_u8; 4];
            core.read(address, &mut bytes).map_err(|error| error.to_string())?;
            let value = u64::from(u32::from_le_bytes(bytes));
            pointer_values.insert(address, (value != 0).then_some(value));
        }
        let mut unavailable = HashSet::new();
        let watches = watches.iter().cloned().map(|mut watch| {
            if let Some(pointer_address) = watch.pointer_address {
                if let Some(base) = pointer_values[&pointer_address] {
                    watch.address = base.saturating_add(watch.pointer_offset);
                } else {
                    unavailable.insert(watch.id.clone());
                }
            }
            watch
        }).collect::<Vec<_>>();
        let requests = watches
            .iter()
            .filter(|watch| !unavailable.contains(&watch.id))
            .map(|watch| ReadRequest {
                variable_id: watch.id.clone(),
                address: watch.address,
                byte_width: watch.byte_width,
                memory_class: classify_address(watch.address),
            })
            .collect::<Vec<_>>();
        let blocks = plan_reads(&requests, MAX_NORMAL_RAM_GAP, MAX_NORMAL_RAM_BLOCK);
        let channels = watches
            .iter()
            .enumerate()
            .map(|(index, watch)| (watch.id.as_str(), index))
            .collect::<HashMap<_, _>>();
        let kinds = watches
            .iter()
            .map(|watch| (watch.id.as_str(), watch.scalar_kind))
            .collect::<HashMap<_, _>>();
        let mut scratch = vec![0_u8; blocks.iter().map(|block| block.byte_len).max().unwrap_or(0)];
        let mut output = Vec::with_capacity(watches.len() * frames);
        for _ in 0..frames {
            let mut frame = vec![f64::NAN; watches.len()];
            for block in &blocks {
                core.read(block.address, &mut scratch[..block.byte_len])
                    .map_err(|error| error.to_string())?;
                for mapping in &block.variables {
                    let width = usize::from(mapping.byte_width.min(8));
                    if let (Some(channel), Some(kind)) = (
                        channels.get(mapping.variable_id.as_str()),
                        kinds.get(mapping.variable_id.as_str()),
                    ) {
                        frame[*channel] =
                            decode(&scratch[mapping.offset..mapping.offset + width], *kind);
                    }
                }
            }
            output.extend(frame);
        }
        Ok(output)
    }
}

impl ProbeRsBackend {
    fn sample_cached(&mut self, watches: &[WatchSpec], frames: usize) -> Result<Vec<f64>, String> {
        if self
            .read_plan
            .as_ref()
            .is_none_or(|plan| plan.watches != watches)
        {
            self.read_plan = Some(CachedReadPlan::new(watches));
        }
        let mut plan = self.read_plan.take().expect("read plan initialized");
        let result = (|| {
            let mut core = self.core()?;
            let mut output = Vec::with_capacity(watches.len() * frames);
            let CachedReadPlan {
                blocks,
                scatter_addresses,
                scatter_values,
                scratch,
                frame,
                ..
            } = &mut plan;
            for _ in 0..frames {
                frame.fill(f64::NAN);
                if !scatter_addresses.is_empty() {
                    core.read_32_scattered(scatter_addresses, scatter_values)
                        .map_err(|error| error.to_string())?;
                }
                for block in blocks.iter() {
                    if let Some(slot) = block.scatter_slot {
                        let bytes = scatter_values[slot].to_le_bytes();
                        for &(channel, offset, byte_width, kind) in &block.mappings {
                            let width = usize::from(byte_width.min(4));
                            frame[channel] = decode(&bytes[offset..offset + width], kind);
                        }
                        continue;
                    }
                    core.read(block.address, &mut scratch[..block.byte_len])
                        .map_err(|error| error.to_string())?;
                    for &(channel, offset, byte_width, kind) in &block.mappings {
                        let width = usize::from(byte_width.min(8));
                        frame[channel] = decode(&scratch[offset..offset + width], kind);
                    }
                }
                output.extend_from_slice(frame);
            }
            Ok(output)
        })();
        self.read_plan = Some(plan);
        result
    }

    fn core(&mut self) -> Result<probe_rs::Core<'_>, String> {
        self.session
            .as_mut()
            .ok_or_else(|| "probe is not connected".to_owned())?
            .core(0)
            .map_err(|error| error.to_string())
    }
}

fn map_core_status(status: CoreStatus) -> TargetState {
    match status {
        CoreStatus::Running => TargetState::Running,
        CoreStatus::Halted(reason) => TargetState::Halted {
            reason: match reason {
                HaltReason::Multiple => "multiple",
                HaltReason::Breakpoint(_) => "breakpoint",
                HaltReason::Exception => "exception",
                HaltReason::Watchpoint => "watchpoint",
                HaltReason::Step => "step",
                HaltReason::Request | HaltReason::External => "pause",
                HaltReason::Unknown => "unknown",
            }
            .into(),
        },
        CoreStatus::Sleeping => TargetState::Sleeping,
        CoreStatus::LockedUp => TargetState::LockedUp,
        CoreStatus::Unknown => TargetState::Unknown,
    }
}

fn decode(bytes: &[u8], kind: cortex_kit_core::ScalarKind) -> f64 {
    let mut raw = [0_u8; 8];
    raw[..bytes.len()].copy_from_slice(bytes);
    match kind {
        cortex_kit_core::ScalarKind::Float32 if bytes.len() == 4 => {
            f32::from_le_bytes(raw[..4].try_into().unwrap()) as f64
        }
        cortex_kit_core::ScalarKind::Float64 if bytes.len() == 8 => f64::from_le_bytes(raw),
        cortex_kit_core::ScalarKind::Signed => {
            let shift = (8 - bytes.len()) * 8;
            ((i64::from_le_bytes(raw) << shift) >> shift) as f64
        }
        cortex_kit_core::ScalarKind::Boolean => (raw.iter().any(|byte| *byte != 0)) as u8 as f64,
        _ => u64::from_le_bytes(raw) as f64,
    }
}

fn classify_address(address: u64) -> MemoryClass {
    if (0x4000_0000..0x6000_0000).contains(&address) {
        MemoryClass::Peripheral
    } else if address >= 0xE000_0000 {
        MemoryClass::Special
    } else {
        MemoryClass::Ram
    }
}

fn format_attach_failure(config: &ProbeConfig, probe_name: &str, detail: &str) -> String {
    let mode = if config.connect_under_reset {
        " under reset"
    } else {
        ""
    };
    let mut message = format!(
        "failed to attach{mode} {} with {probe_name} at {} kHz: {detail}",
        config.chip, config.speed_khz
    );

    if looks_like_unreachable_target(detail) {
        message.push_str(
            "\nTarget communication checks:\n\
             - Confirm that the target is powered and the probe can sense its reference voltage.\n\
             - Check SWDIO, SWCLK, and GND wiring; retry at a lower SWD speed if needed.\n",
        );
        if config.connect_under_reset {
            message.push_str(
                "- connectUnderReset is enabled; check that NRST is connected and can be driven by the probe.\n",
            );
        } else {
            message.push_str(
                "- If running firmware blocks debug access, connect NRST and retry with probe.connectUnderReset=true.\n",
            );
        }
        message.push_str(
            "- Power-cycle the board and, if possible, hold it in a BOOT-safe state so startup firmware cannot reconfigure debug pins, enter low power, or fault before attach.",
        );
    }
    message
}

fn looks_like_unreachable_target(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    [
        "jtagdbgpowererror",
        "jtaggetidcodeerror",
        "target unreachable",
        "targetunreachable",
        "target not found",
        "failed to read dpidr",
        "no debug access port",
        "no access port",
    ]
    .iter()
    .any(|needle| detail.contains(needle))
}

#[cfg(test)]
mod attach_diagnostics_tests {
    use super::*;

    fn config(connect_under_reset: bool) -> ProbeConfig {
        ProbeConfig {
            chip: "ExampleTarget".into(),
            selector: Some("auto".into()),
            protocol: "swd".into(),
            speed_khz: 1_000,
            connect_under_reset,
        }
    }

    #[test]
    fn appends_wiring_help_without_hiding_jtag_power_cause() {
        let detail = "Arm(DebugPort(JtagDbgPowerError))";
        let message = format_attach_failure(&config(false), "ST-Link", detail);
        assert!(message.contains(detail));
        assert!(message.contains("target is powered"));
        assert!(message.contains("SWDIO, SWCLK, and GND"));
        assert!(message.contains("probe.connectUnderReset=true"));
        assert!(message.contains("BOOT-safe"));
    }

    #[test]
    fn under_reset_failure_calls_out_nrst() {
        let message = format_attach_failure(
            &config(true),
            "CMSIS-DAP",
            "Target unreachable while reading DPIDR",
        );
        assert!(message.contains("failed to attach under reset"));
        assert!(message.contains("NRST is connected"));
        assert!(!message.contains("probe.connectUnderReset=true"));
    }

    #[test]
    fn unrelated_attach_error_stays_concise() {
        let detail = "PermissionDenied";
        let message = format_attach_failure(&config(false), "CMSIS-DAP", detail);
        assert!(message.contains(detail));
        assert!(!message.contains("Target communication checks"));
    }

    #[test]
    fn maps_probe_status_without_assuming_attach_halts() {
        assert_eq!(map_core_status(CoreStatus::Running), TargetState::Running);
        assert_eq!(map_core_status(CoreStatus::Sleeping), TargetState::Sleeping);
        assert_eq!(map_core_status(CoreStatus::LockedUp), TargetState::LockedUp);
        assert_eq!(map_core_status(CoreStatus::Unknown), TargetState::Unknown);
        assert_eq!(
            map_core_status(CoreStatus::Halted(HaltReason::Breakpoint(
                probe_rs::BreakpointCause::Hardware
            ))),
            TargetState::Halted {
                reason: "breakpoint".into()
            }
        );
    }

    fn watch(id: &str, address: u64, byte_width: u8, scalar_kind: ScalarKind) -> WatchSpec {
        WatchSpec {
            id: id.into(),
            address,
            pointer_address: None,
            pointer_offset: 0,
            byte_width,
            scalar_kind,
        }
    }

    #[test]
    fn caches_disjoint_words_as_one_scatter_transaction() {
        let plan = CachedReadPlan::new(&[
            watch("first", 0x2000_0000, 4, ScalarKind::Unsigned),
            watch("second", 0x2000_1000, 4, ScalarKind::Float32),
            watch("third", 0x4000_0010, 4, ScalarKind::Unsigned),
        ]);

        assert_eq!(
            plan.scatter_addresses,
            [0x2000_0000, 0x2000_1000, 0x4000_0010]
        );
        assert_eq!(plan.scatter_values, [0, 0, 0]);
        assert_eq!(
            plan.blocks
                .iter()
                .map(|block| block.scatter_slot)
                .collect::<Vec<_>>(),
            [Some(0), Some(1), Some(2)]
        );
    }

    #[test]
    fn leaves_contiguous_and_wide_blocks_on_normal_memory_reads() {
        let plan = CachedReadPlan::new(&[
            watch("left", 0x2000_0000, 4, ScalarKind::Unsigned),
            watch("right", 0x2000_0004, 4, ScalarKind::Unsigned),
            watch("wide", 0x2000_1000, 8, ScalarKind::Float64),
        ]);

        assert!(plan.scatter_addresses.is_empty());
        assert_eq!(
            plan.blocks
                .iter()
                .map(|block| (block.address, block.byte_len, block.scatter_slot))
                .collect::<Vec<_>>(),
            [(0x2000_0000, 8, None), (0x2000_1000, 8, None),]
        );
    }
}
