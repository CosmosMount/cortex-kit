use std::{collections::HashMap, path::Path};

use cortex_kit_core::{ScalarKind, VariableDescriptor};

use crate::{Backend, Breakpoint, ProbeConfig, RegisterValue, StepKind, WatchSpec};

pub struct MockBackend {
    running: bool,
    phase: f64,
    memory: HashMap<u64, u8>,
}

impl Default for MockBackend {
    fn default() -> Self {
        Self {
            running: false,
            phase: 0.0,
            memory: HashMap::new(),
        }
    }
}

impl Backend for MockBackend {
    fn name(&self) -> String {
        "Cortex Kit Mock Probe".into()
    }
    fn catalog(&self) -> Vec<VariableDescriptor> {
        mock_catalog()
    }
    fn connect(&mut self, _: &ProbeConfig) -> Result<(), String> {
        self.running = false;
        Ok(())
    }
    fn target_state(&mut self) -> Result<cortex_kit_core::TargetState, String> {
        Ok(if self.running {
            cortex_kit_core::TargetState::Running
        } else {
            cortex_kit_core::TargetState::Halted {
                reason: "entry".into(),
            }
        })
    }
    fn disconnect(&mut self) {
        self.running = false;
    }
    fn halt(&mut self) -> Result<(), String> {
        self.running = false;
        Ok(())
    }
    fn resume(&mut self) -> Result<(), String> {
        self.running = true;
        Ok(())
    }
    fn reset(&mut self) -> Result<(), String> {
        self.phase = 0.0;
        self.running = false;
        Ok(())
    }
    fn step(&mut self, _: StepKind) -> Result<(), String> {
        self.phase += 0.01;
        Ok(())
    }
    fn set_breakpoints(&mut self, _: &[Breakpoint]) -> Result<(), String> {
        Ok(())
    }
    fn read_registers(&mut self) -> Result<Vec<RegisterValue>, String> {
        Ok(vec![
            RegisterValue {
                name: "r0".into(),
                value: "0x00000000".into(),
            },
            RegisterValue {
                name: "pc".into(),
                value: "0x08000000".into(),
            },
            RegisterValue {
                name: "xPSR".into(),
                value: "0x01000000".into(),
            },
        ])
    }
    fn read_memory(&mut self, address: u64, data: &mut [u8]) -> Result<(), String> {
        for (index, byte) in data.iter_mut().enumerate() {
            *byte = *self.memory.get(&(address + index as u64)).unwrap_or(&0);
        }
        Ok(())
    }
    fn write_memory(&mut self, address: u64, data: &[u8]) -> Result<(), String> {
        for (index, byte) in data.iter().enumerate() {
            self.memory.insert(address + index as u64, *byte);
        }
        Ok(())
    }
    fn flash(&mut self, path: &Path, _: bool, _: bool) -> Result<(), String> {
        if path.exists() {
            self.phase = 0.0;
            Ok(())
        } else {
            Err(format!("program does not exist: {}", path.display()))
        }
    }
    fn sample(&mut self, watches: &[WatchSpec], frames: usize) -> Result<Vec<f64>, String> {
        let mut values = Vec::with_capacity(watches.len() * frames);
        for _ in 0..frames {
            self.phase += 1.0 / 1000.0;
            for watch in watches {
                let value =
                    memory_value(&self.memory, watch).unwrap_or_else(|| match watch.id.as_str() {
                        "mock.sine" => (self.phase * std::f64::consts::TAU * 37.0).sin(),
                        "mock.cosine" => (self.phase * std::f64::consts::TAU * 11.0).cos() * 0.6,
                        "mock.ramp" => (self.phase * 2.0) % 2.0 - 1.0,
                        "mock.noise" => pseudo_noise((self.phase * 1_000_000.0) as u64),
                        _ => 0.0,
                    });
                values.push(value);
            }
        }
        Ok(values)
    }
}

fn descriptor(id: &str, name: &str, expression: &str, address: u64) -> VariableDescriptor {
    VariableDescriptor {
        id: id.into(),
        name: name.into(),
        expression: expression.into(),
        type_name: "float".into(),
        address: Some(address),
        byte_width: 4,
        scalar_kind: ScalarKind::Float32,
        writable: true,
        children: Vec::new(),
    }
}
pub fn mock_catalog() -> Vec<VariableDescriptor> {
    vec![
        VariableDescriptor {
            id: "mock.signal".into(),
            name: "signal".into(),
            expression: "signal".into(),
            type_name: "MockSignals".into(),
            address: Some(0x2000_0000),
            byte_width: 8,
            scalar_kind: ScalarKind::Unsigned,
            writable: false,
            children: vec![
                descriptor("mock.sine", "sine_37hz", "signal.sine_37hz", 0x2000_0000),
                descriptor(
                    "mock.cosine",
                    "cosine_11hz",
                    "signal.cosine_11hz",
                    0x2000_0004,
                ),
            ],
        },
        descriptor("mock.ramp", "control.ramp", "control.ramp", 0x2000_0008),
        descriptor("mock.noise", "adc.noise", "adc.noise", 0x2000_000c),
    ]
}
fn memory_value(memory: &HashMap<u64, u8>, watch: &WatchSpec) -> Option<f64> {
    let width = usize::from(watch.byte_width);
    let bytes = (0..width)
        .map(|index| memory.get(&(watch.address + index as u64)).copied())
        .collect::<Option<Vec<_>>>()?;
    let mut raw = [0_u8; 8];
    raw[..width.min(8)].copy_from_slice(&bytes[..width.min(8)]);
    Some(match (watch.scalar_kind, width) {
        (ScalarKind::Float32, 4) => f32::from_le_bytes(raw[..4].try_into().ok()?) as f64,
        (ScalarKind::Float64, 8) => f64::from_le_bytes(raw),
        (ScalarKind::Boolean, _) => (raw[0] != 0) as u8 as f64,
        (ScalarKind::Unsigned, _) => u64::from_le_bytes(raw) as f64,
        (ScalarKind::Signed, 1) => i8::from_le_bytes([raw[0]]) as f64,
        (ScalarKind::Signed, 2) => i16::from_le_bytes(raw[..2].try_into().ok()?) as f64,
        (ScalarKind::Signed, 4) => i32::from_le_bytes(raw[..4].try_into().ok()?) as f64,
        (ScalarKind::Signed, 8) => i64::from_le_bytes(raw) as f64,
        _ => return None,
    })
}
fn pseudo_noise(mut value: u64) -> f64 {
    value ^= value << 13;
    value ^= value >> 7;
    value ^= value << 17;
    (value as i64 as f64 / i64::MAX as f64).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn samples_are_interleaved_by_frame() {
        let mut backend = MockBackend::default();
        let watches = vec![
            WatchSpec {
                id: "mock.sine".into(),
                address: 0,
                byte_width: 4,
                scalar_kind: ScalarKind::Float32,
            },
            WatchSpec {
                id: "mock.ramp".into(),
                address: 4,
                byte_width: 4,
                scalar_kind: ScalarKind::Float32,
            },
        ];
        assert_eq!(backend.sample(&watches, 3).unwrap().len(), 6);
    }

    #[test]
    fn written_mock_value_overrides_the_synthetic_signal() {
        let mut backend = MockBackend::default();
        backend
            .write_memory(0x2000_0000, &12.5_f32.to_le_bytes())
            .unwrap();
        let watch = WatchSpec {
            id: "mock.sine".into(),
            address: 0x2000_0000,
            byte_width: 4,
            scalar_kind: ScalarKind::Float32,
        };
        assert_eq!(backend.sample(&[watch], 1).unwrap(), vec![12.5]);
    }
}
