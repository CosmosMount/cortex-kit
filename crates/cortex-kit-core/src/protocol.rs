use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TargetState {
    Disconnected,
    Connecting,
    Running,
    Halted {
        reason: String,
    },
    Sleeping,
    LockedUp,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: String,
    pub program_generation: u64,
    pub stream_epoch: u64,
    pub stop_id: u64,
    pub revision: u64,
    pub target_state: TargetState,
    pub probe_name: Option<String>,
    pub chip: Option<String>,
    pub actual_samples_per_second: f64,
    pub dropped_frames: u64,
    pub last_error: Option<String>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            program_generation: 0,
            stream_epoch: 0,
            stop_id: 0,
            revision: 0,
            target_state: TargetState::Disconnected,
            probe_name: None,
            chip: None,
            actual_samples_per_second: 0.0,
            dropped_frames: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScalarKind {
    Unsigned,
    Signed,
    Float32,
    Float64,
    Boolean,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableDescriptor {
    pub id: String,
    pub name: String,
    pub expression: String,
    pub type_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_address: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_offset: Option<u64>,
    pub byte_width: u8,
    pub scalar_kind: ScalarKind,
    pub writable: bool,
    pub children: Vec<VariableDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionSpec {
    pub id: String,
    pub expression: String,
    pub requested_samples_per_second: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleBatch {
    pub protocol_version: u16,
    pub session_id: String,
    pub program_generation: u64,
    pub stream_epoch: u64,
    pub batch_sequence: u64,
    pub channel_ids: Vec<String>,
    pub sample_count: u32,
    pub start_timestamp_ns: u64,
    pub sample_period_ns: u64,
    pub dropped_frames: u64,
    /// Interleaved channel-major values: sample0/channel0, sample0/channel1, ...
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionStats {
    pub requested_samples_per_second: f64,
    pub actual_samples_per_second: f64,
    pub mean_interval_micros: f64,
    pub p95_interval_micros: f64,
    pub p99_interval_micros: f64,
    pub dropped_frames: u64,
    pub read_errors: u64,
}
