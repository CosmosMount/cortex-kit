use std::{
    path::PathBuf,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use cortex_kit_core::{
    AcquisitionStats, SampleBatch, ScalarKind, SessionState, TargetState, VariableDescriptor,
};
use crossbeam_channel::{Receiver, Sender, after, bounded, select_biased};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub selector: String,
    pub identifier: String,
    pub serial_number: Option<String>,
    pub probe_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeConfig {
    pub chip: String,
    pub selector: Option<String>,
    pub protocol: String,
    pub speed_khz: u32,
    #[serde(default)]
    pub connect_under_reset: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    In,
    Over,
    Out,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    pub address: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSpec {
    pub id: String,
    pub address: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_address: Option<u64>,
    #[serde(default)]
    pub pointer_offset: u64,
    pub byte_width: u8,
    pub scalar_kind: ScalarKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterValue {
    pub name: String,
    pub value: String,
}

#[derive(Debug)]
pub enum WorkerCommand {
    Connect(ProbeConfig),
    Disconnect,
    Halt,
    Resume,
    Reset,
    Step(StepKind),
    RunToAddress {
        address: u64,
        restore_breakpoints: Vec<Breakpoint>,
        timeout: Duration,
    },
    SetBreakpoints(Vec<Breakpoint>),
    ReadRegisters,
    ReadValues(Vec<WatchSpec>),
    ReadMemory {
        address: u64,
        length: usize,
    },
    WriteMemory {
        address: u64,
        data: Vec<u8>,
    },
    WriteMemoryVerified {
        address: u64,
        data: Vec<u8>,
    },
    Flash {
        path: PathBuf,
        verify: bool,
        reset_after: bool,
    },
    SetSubscriptions {
        watches: Vec<WatchSpec>,
        requested_hz: u32,
        background_watches: Vec<WatchSpec>,
        background_hz: u32,
    },
    Benchmark {
        duration: Duration,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum WorkerReply {
    Ok,
    State(SessionState),
    Registers(Vec<RegisterValue>),
    Values(Vec<f64>),
    Memory(Vec<u8>),
    Benchmark(AcquisitionStats),
}

#[derive(Debug, Clone)]
pub enum WorkerEvent {
    State {
        state: SessionState,
        spontaneous_stop: bool,
    },
    Samples(SampleBatch),
    Error(String),
}

pub trait Backend: Send + 'static {
    fn name(&self) -> String;
    fn catalog(&self) -> Vec<VariableDescriptor> {
        Vec::new()
    }
    fn connect(&mut self, config: &ProbeConfig) -> Result<(), String>;
    /// Read the target's current execution state from the backend.
    ///
    /// This must reflect the target rather than an adapter-side cached state so
    /// that attaching to firmware which is already running does not result in a
    /// second, invalid resume request.
    fn target_state(&mut self) -> Result<TargetState, String>;
    fn disconnect(&mut self);
    fn halt(&mut self) -> Result<(), String>;
    fn resume(&mut self) -> Result<(), String>;
    fn reset(&mut self) -> Result<(), String>;
    fn step(&mut self, kind: StepKind) -> Result<(), String>;
    fn set_breakpoints(&mut self, breakpoints: &[Breakpoint]) -> Result<(), String>;
    fn run_to_address(
        &mut self,
        address: u64,
        restore_breakpoints: &[Breakpoint],
        timeout: Duration,
    ) -> Result<(), String> {
        let result = (|| {
            self.set_breakpoints(&[Breakpoint { address }])?;
            self.resume()?;
            let deadline = Instant::now() + timeout;
            loop {
                match self.target_state()? {
                    TargetState::Running | TargetState::Sleeping => {}
                    TargetState::Halted { .. } => return Ok(()),
                    state => {
                        return Err(format!(
                            "target entered {state:?} while running to 0x{address:08x}"
                        ));
                    }
                }
                if Instant::now() >= deadline {
                    let _ = self.halt();
                    return Err(format!("timed out running to 0x{address:08x}"));
                }
                thread::sleep(Duration::from_millis(1));
            }
        })();
        let restore = self.set_breakpoints(restore_breakpoints);
        match (result, restore) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) => Err(error),
            (Ok(()), Err(error)) => Err(format!(
                "reached entry point, but restoring breakpoints failed: {error}"
            )),
            (Err(run), Err(restore)) => Err(format!(
                "{run}; additionally, restoring breakpoints failed: {restore}"
            )),
        }
    }
    fn read_registers(&mut self) -> Result<Vec<RegisterValue>, String>;
    fn read_memory(&mut self, address: u64, data: &mut [u8]) -> Result<(), String>;
    fn write_memory(&mut self, address: u64, data: &[u8]) -> Result<(), String>;
    fn write_memory_verified(&mut self, address: u64, data: &[u8]) -> Result<Vec<u8>, String> {
        self.write_memory(address, data)?;
        let mut readback = vec![0; data.len()];
        self.read_memory(address, &mut readback)?;
        Ok(readback)
    }
    fn flash(
        &mut self,
        path: &std::path::Path,
        verify: bool,
        reset_after: bool,
    ) -> Result<(), String>;
    fn sample(&mut self, watches: &[WatchSpec], frames: usize) -> Result<Vec<f64>, String>;
}

struct Envelope {
    command: WorkerCommand,
    reply: Sender<Result<WorkerReply, String>>,
}

pub struct WorkerHandle {
    urgent: Sender<Envelope>,
    normal: Sender<Envelope>,
    pub events: Receiver<WorkerEvent>,
    catalog: Vec<VariableDescriptor>,
}

impl WorkerHandle {
    pub fn catalog(&self) -> &[VariableDescriptor] {
        &self.catalog
    }
    pub fn call(&self, command: WorkerCommand) -> Result<WorkerReply, String> {
        self.send(&self.normal, command)
    }
    pub fn call_urgent(&self, command: WorkerCommand) -> Result<WorkerReply, String> {
        self.send(&self.urgent, command)
    }
    fn send(
        &self,
        channel: &Sender<Envelope>,
        command: WorkerCommand,
    ) -> Result<WorkerReply, String> {
        let (reply_tx, reply_rx) = bounded(1);
        channel
            .send(Envelope {
                command,
                reply: reply_tx,
            })
            .map_err(|_| "probe worker stopped".to_owned())?;
        reply_rx
            .recv()
            .map_err(|_| "probe worker stopped".to_owned())?
    }
}

pub fn spawn_worker(backend: impl Backend) -> WorkerHandle {
    let catalog = backend.catalog();
    let (urgent_tx, urgent_rx) = bounded(32);
    let (normal_tx, normal_rx) = bounded(256);
    let (event_tx, event_rx) = bounded(64);
    thread::Builder::new()
        .name("cortex-kit-probe".into())
        .spawn(move || run_worker(Box::new(backend), urgent_rx, normal_rx, event_tx))
        .expect("spawn probe worker");
    WorkerHandle {
        urgent: urgent_tx,
        normal: normal_tx,
        events: event_rx,
        catalog,
    }
}

fn run_worker(
    mut backend: Box<dyn Backend>,
    urgent: Receiver<Envelope>,
    normal: Receiver<Envelope>,
    events: Sender<WorkerEvent>,
) {
    let mut state = SessionState {
        session_id: make_session_id(),
        ..Default::default()
    };
    let mut watches = Vec::new();
    let mut requested_hz = 1_000_u32;
    let mut background = BackgroundAcquisition::default();
    let mut next_acquisition = Instant::now();
    let mut batch_sequence = 0_u64;
    let started = Instant::now();
    let mut statistics_started = Instant::now();
    let mut sampled_frames = 0_u64;
    let mut previous_acquisition_end_ns = None;
    let mut frame_cost_ns = None;
    let mut next_status_poll = Instant::now();
    let mut running = true;
    while running {
        let acquisition_timer = after(acquisition_wait(
            &state.target_state,
            !watches.is_empty(),
            requested_hz,
        ));
        select_biased! {
            recv(urgent) -> message => if let Ok(envelope) = message {
                let previous_state = state.target_state.clone();
                let previously_acquiring = !watches.is_empty();
                let subscriptions_changed = matches!(&envelope.command, WorkerCommand::SetSubscriptions { .. });
                running = handle_command(&mut *backend, envelope, &events, &mut state, &mut watches, &mut requested_hz, &mut background);
                if subscriptions_changed || state.target_state != previous_state {
                    frame_cost_ns = None;
                    next_acquisition = Instant::now();
                    previous_acquisition_end_ns = None;
                    background.previous_end_ns = None;
                    statistics_started = Instant::now();
                    sampled_frames = 0;
                }
                if status_schedule_changed(&previous_state, &state.target_state, previously_acquiring, !watches.is_empty()) {
                    next_status_poll = schedule_next_status_poll(Instant::now(), !watches.is_empty());
                }
            },
            recv(normal) -> message => if let Ok(envelope) = message {
                let previous_state = state.target_state.clone();
                let previously_acquiring = !watches.is_empty();
                let subscriptions_changed = matches!(&envelope.command, WorkerCommand::SetSubscriptions { .. });
                running = handle_command(&mut *backend, envelope, &events, &mut state, &mut watches, &mut requested_hz, &mut background);
                if subscriptions_changed || state.target_state != previous_state {
                    frame_cost_ns = None;
                    next_acquisition = Instant::now();
                    previous_acquisition_end_ns = None;
                    background.previous_end_ns = None;
                    statistics_started = Instant::now();
                    sampled_frames = 0;
                }
                if status_schedule_changed(&previous_state, &state.target_state, previously_acquiring, !watches.is_empty()) {
                    next_status_poll = schedule_next_status_poll(Instant::now(), !watches.is_empty());
                }
            },
            recv(acquisition_timer) -> _ => {
                if is_executing(&state.target_state) && Instant::now() >= next_status_poll {
                    match backend.target_state() {
                        Ok(observed) => {
                            if apply_polled_target_state(&mut state, observed) {
                                previous_acquisition_end_ns = None;
                                sampled_frames = 0;
                                statistics_started = Instant::now();
                                let _ = events.try_send(WorkerEvent::State {
                                    state: state.clone(),
                                    spontaneous_stop: true,
                                });
                            }
                        }
                        Err(error) if state.last_error.as_deref() != Some(error.as_str()) => {
                            state.last_error = Some(error.clone());
                            state.revision += 1;
                            let _ = events.try_send(WorkerEvent::Error(error));
                        }
                        Err(_) => {}
                    }
                    next_status_poll = schedule_next_status_poll(Instant::now(), !watches.is_empty());
                }
                if is_executing(&state.target_state) && !watches.is_empty() && Instant::now() >= next_acquisition {
                    let frames = acquisition_frames(requested_hz, frame_cost_ns);
                    next_acquisition = Instant::now() + Duration::from_secs_f64(frames as f64 / requested_hz as f64);
                    let acquisition_started_ns = elapsed_ns(started);
                    let sample_result = backend.sample(&watches, frames);
                    let acquisition_finished_ns = elapsed_ns(started);
                    frame_cost_ns = Some((acquisition_finished_ns.saturating_sub(acquisition_started_ns) / frames as u64).max(1));
                    match sample_result {
                        Ok(values) => {
                            let timing = measured_batch_timing(
                                acquisition_started_ns,
                                acquisition_finished_ns,
                                frames,
                                previous_acquisition_end_ns,
                            );
                            previous_acquisition_end_ns = Some(acquisition_finished_ns);
                            batch_sequence += 1;
                            let batch = SampleBatch { protocol_version: 1, session_id: state.session_id.clone(), program_generation: state.program_generation, stream_epoch: state.stream_epoch, batch_sequence, channel_ids: watches.iter().map(|watch| watch.id.clone()).collect(), sample_count: frames as u32, start_timestamp_ns: timing.start_timestamp_ns, sample_period_ns: timing.sample_period_ns, dropped_frames: state.dropped_frames, values };
                            sampled_frames += frames as u64;
                            if events.try_send(WorkerEvent::Samples(batch)).is_err() { state.dropped_frames += frames as u64; }
                            if statistics_started.elapsed() >= Duration::from_secs(1) {
                                state.actual_samples_per_second = sampled_frames as f64 / statistics_started.elapsed().as_secs_f64();
                                state.revision += 1;
                                let _ = events.try_send(WorkerEvent::State {
                                    state: state.clone(),
                                    spontaneous_stop: false,
                                });
                                sampled_frames = 0;
                                statistics_started = Instant::now();
                            }
                        }
                        Err(error) => { previous_acquisition_end_ns = Some(acquisition_finished_ns); state.last_error = Some(error.clone()); state.revision += 1; let _ = events.try_send(WorkerEvent::Error(error)); }
                    }
                } else if !is_executing(&state.target_state) || watches.is_empty() {
                    previous_acquisition_end_ns = None;
                } else if requested_hz >= 500 {
                    // Avoid the coarse Windows timer while preserving the requested
                    // rate as an upper bound for fast probes and the mock backend.
                    thread::yield_now();
                }
                if is_executing(&state.target_state) {
                    background.sample_if_due(&mut *backend, &events, &mut state, started, &mut batch_sequence);
                } else {
                    background.previous_end_ns = None;
                }
            }
        }
    }
    backend.disconnect();
}

// Keep a high requested rate from turning a slow USB probe into a seconds-long
// uninterruptible read. Start with one frame, then budget about 32 ms per call.
// This amortizes core acquisition, allocation, event dispatch and binary framing
// while remaining below an interactive command-latency frame on real probes.
fn acquisition_frames(requested_hz: u32, frame_cost_ns: Option<u64>) -> usize {
    let requested = (requested_hz.max(1) as usize).div_ceil(125);
    let budget = frame_cost_ns.map_or(1, |cost| (32_000_000 / cost.max(1)).max(1) as usize);
    requested.min(budget)
}

/// Low-rate consumers get their own real reads and timestamped batches. Never
/// repeat a cached value in a high-rate batch: that would corrupt plots/FFTs.
struct BackgroundAcquisition {
    watches: Vec<WatchSpec>,
    hz: u32,
    next: Instant,
    previous_end_ns: Option<u64>,
}

impl Default for BackgroundAcquisition {
    fn default() -> Self {
        Self {
            watches: Vec::new(),
            hz: 20,
            next: Instant::now(),
            previous_end_ns: None,
        }
    }
}

impl BackgroundAcquisition {
    fn sample_if_due(
        &mut self,
        backend: &mut dyn Backend,
        events: &Sender<WorkerEvent>,
        state: &mut SessionState,
        started: Instant,
        sequence: &mut u64,
    ) {
        if self.watches.is_empty() || Instant::now() < self.next {
            return;
        }
        let frames = (self.hz as usize).div_ceil(500);
        self.next = Instant::now() + Duration::from_secs_f64(frames as f64 / self.hz as f64);
        let begin = elapsed_ns(started);
        let result = backend.sample(&self.watches, frames);
        let end = elapsed_ns(started);
        let timing = measured_batch_timing(begin, end, frames, self.previous_end_ns);
        self.previous_end_ns = Some(end);
        match result {
            Ok(values) => {
                *sequence += 1;
                let batch = SampleBatch {
                    protocol_version: 1,
                    session_id: state.session_id.clone(),
                    program_generation: state.program_generation,
                    stream_epoch: state.stream_epoch,
                    batch_sequence: *sequence,
                    channel_ids: self.watches.iter().map(|watch| watch.id.clone()).collect(),
                    sample_count: frames as u32,
                    start_timestamp_ns: timing.start_timestamp_ns,
                    sample_period_ns: timing.sample_period_ns,
                    dropped_frames: state.dropped_frames,
                    values,
                };
                if events.try_send(WorkerEvent::Samples(batch)).is_err() {
                    state.dropped_frames += frames as u64;
                }
            }
            Err(error) => {
                state.last_error = Some(error.clone());
                state.revision += 1;
                let _ = events.try_send(WorkerEvent::Error(error));
            }
        }
    }
}

fn handle_command(
    backend: &mut dyn Backend,
    envelope: Envelope,
    events: &Sender<WorkerEvent>,
    state: &mut SessionState,
    watches: &mut Vec<WatchSpec>,
    requested_hz: &mut u32,
    background: &mut BackgroundAcquisition,
) -> bool {
    let Envelope { command, reply } = envelope;
    if matches!(command, WorkerCommand::Shutdown) {
        let _ = reply.send(Ok(WorkerReply::Ok));
        return false;
    }
    let result = match command {
        WorkerCommand::Connect(config) => backend.connect(&config).and_then(|()| {
            let target_state = backend
                .target_state()
                .inspect_err(|_| backend.disconnect())?;
            state.probe_name = Some(backend.name());
            state.chip = Some(config.chip);
            state.target_state = target_state;
            state.revision += 1;
            Ok(WorkerReply::State(state.clone()))
        }),
        WorkerCommand::Disconnect => {
            backend.disconnect();
            state.target_state = TargetState::Disconnected;
            state.revision += 1;
            Ok(WorkerReply::State(state.clone()))
        }
        WorkerCommand::Halt => backend.halt().map(|()| {
            state.target_state = TargetState::Halted {
                reason: "pause".into(),
            };
            state.stop_id += 1;
            state.stream_epoch += 1;
            state.revision += 1;
            WorkerReply::State(state.clone())
        }),
        WorkerCommand::Resume => resume(backend, state),
        WorkerCommand::Reset => backend.reset().map(|()| {
            state.target_state = TargetState::Halted {
                reason: "reset".into(),
            };
            state.stop_id += 1;
            state.stream_epoch += 1;
            state.revision += 1;
            WorkerReply::State(state.clone())
        }),
        WorkerCommand::Step(kind) => backend.step(kind).map(|()| {
            state.target_state = TargetState::Halted {
                reason: "step".into(),
            };
            state.stop_id += 1;
            state.revision += 1;
            WorkerReply::State(state.clone())
        }),
        WorkerCommand::RunToAddress {
            address,
            restore_breakpoints,
            timeout,
        } => backend
            .run_to_address(address, &restore_breakpoints, timeout)
            .map(|()| {
                state.target_state = TargetState::Halted {
                    reason: "entry".into(),
                };
                state.stop_id += 1;
                state.stream_epoch += 1;
                state.revision += 1;
                WorkerReply::State(state.clone())
            }),
        WorkerCommand::SetBreakpoints(items) => {
            backend.set_breakpoints(&items).map(|()| WorkerReply::Ok)
        }
        WorkerCommand::ReadRegisters => backend.read_registers().map(WorkerReply::Registers),
        WorkerCommand::ReadValues(watches) => backend.sample(&watches, 1).map(WorkerReply::Values),
        WorkerCommand::ReadMemory { address, length } => {
            let mut bytes = vec![0; length];
            backend
                .read_memory(address, &mut bytes)
                .map(|()| WorkerReply::Memory(bytes))
        }
        WorkerCommand::WriteMemory { address, data } => backend
            .write_memory(address, &data)
            .map(|()| WorkerReply::Ok),
        WorkerCommand::WriteMemoryVerified { address, data } => backend
            .write_memory_verified(address, &data)
            .map(WorkerReply::Memory),
        WorkerCommand::Flash {
            path,
            verify,
            reset_after,
        } => backend.flash(&path, verify, reset_after).map(|()| {
            state.program_generation += 1;
            state.stream_epoch += 1;
            state.stop_id += 1;
            state.target_state = TargetState::Halted {
                reason: "flash".into(),
            };
            state.revision += 1;
            WorkerReply::State(state.clone())
        }),
        WorkerCommand::SetSubscriptions {
            watches: next,
            requested_hz: hz,
            background_watches,
            background_hz,
        } => {
            *background = BackgroundAcquisition {
                watches: background_watches
                    .into_iter()
                    .filter(|watch| !next.iter().any(|fast| fast.id == watch.id))
                    .collect(),
                hz: background_hz.clamp(1, 1_000),
                ..Default::default()
            };
            *watches = next;
            *requested_hz = hz.clamp(1, 100_000);
            Ok(WorkerReply::Ok)
        }
        WorkerCommand::Benchmark { duration } => {
            benchmark(backend, watches, *requested_hz, duration).map(WorkerReply::Benchmark)
        }
        WorkerCommand::Shutdown => unreachable!(),
    };
    match &result {
        Ok(WorkerReply::State(next)) => {
            let _ = events.try_send(WorkerEvent::State {
                state: next.clone(),
                spontaneous_stop: false,
            });
        }
        Err(error) => {
            state.last_error = Some(error.clone());
            state.revision += 1;
            let _ = events.try_send(WorkerEvent::Error(error.clone()));
        }
        _ => {}
    }
    let _ = reply.send(result);
    true
}

fn benchmark(
    backend: &mut dyn Backend,
    watches: &[WatchSpec],
    requested_hz: u32,
    duration: Duration,
) -> Result<AcquisitionStats, String> {
    if watches.is_empty() {
        return Err("select at least one variable".into());
    }
    let deadline = Instant::now() + duration;
    let mut instants = Vec::new();
    let mut read_errors = 0;
    while Instant::now() < deadline {
        match backend.sample(watches, 1) {
            Ok(_) => instants.push(Instant::now()),
            Err(_) => read_errors += 1,
        }
    }
    let mut intervals: Vec<f64> = instants
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).as_secs_f64() * 1e6)
        .collect();
    intervals.sort_by(f64::total_cmp);
    let elapsed = duration.as_secs_f64().max(f64::EPSILON);
    let percentile = |p: f64| {
        intervals
            .get(((intervals.len().saturating_sub(1)) as f64 * p) as usize)
            .copied()
            .unwrap_or(0.0)
    };
    Ok(AcquisitionStats {
        requested_samples_per_second: requested_hz as f64,
        actual_samples_per_second: instants.len() as f64 / elapsed,
        mean_interval_micros: if intervals.is_empty() {
            0.0
        } else {
            intervals.iter().sum::<f64>() / intervals.len() as f64
        },
        p95_interval_micros: percentile(0.95),
        p99_interval_micros: percentile(0.99),
        dropped_frames: 0,
        read_errors,
    })
}

fn resume(backend: &mut dyn Backend, state: &mut SessionState) -> Result<WorkerReply, String> {
    let backend_state = backend.target_state()?;
    if is_executing(&backend_state) {
        if state.target_state != backend_state {
            if !is_executing(&state.target_state) {
                state.stream_epoch += 1;
            }
            state.target_state = backend_state;
            state.revision += 1;
        }
        return Ok(WorkerReply::State(state.clone()));
    }

    backend.resume()?;
    state.target_state = TargetState::Running;
    state.stream_epoch += 1;
    state.revision += 1;
    Ok(WorkerReply::State(state.clone()))
}

fn is_executing(state: &TargetState) -> bool {
    matches!(state, TargetState::Running | TargetState::Sleeping)
}

const STATUS_POLL_WITHOUT_WATCHES: Duration = Duration::from_millis(20);
const STATUS_POLL_WHILE_ACQUIRING: Duration = Duration::from_millis(100);

fn acquisition_wait(state: &TargetState, has_watches: bool, requested_hz: u32) -> Duration {
    if is_executing(state) && has_watches && requested_hz >= 500 {
        Duration::ZERO
    } else {
        Duration::from_millis(2)
    }
}

fn schedule_next_status_poll(now: Instant, acquiring: bool) -> Instant {
    now + if acquiring {
        STATUS_POLL_WHILE_ACQUIRING
    } else {
        STATUS_POLL_WITHOUT_WATCHES
    }
}

fn status_schedule_changed(
    previous_state: &TargetState,
    current_state: &TargetState,
    previously_acquiring: bool,
    currently_acquiring: bool,
) -> bool {
    previous_state != current_state || previously_acquiring != currently_acquiring
}

fn apply_polled_target_state(state: &mut SessionState, observed: TargetState) -> bool {
    if !is_executing(&state.target_state)
        || !matches!(observed, TargetState::Halted { .. } | TargetState::LockedUp)
    {
        return false;
    }

    state.target_state = observed;
    state.stop_id += 1;
    state.stream_epoch += 1;
    state.revision += 1;
    state.actual_samples_per_second = 0.0;
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BatchTiming {
    start_timestamp_ns: u64,
    sample_period_ns: u64,
}

/// Approximate the acquisition instants represented by a backend call.
///
/// A batch can encode only one period, so values are treated as uniformly
/// spaced reads ending at `acquisition_finished_ns`. After the first batch,
/// the period comes from consecutive measured completion times. This accounts
/// for both probe read time and worker scheduling without presenting the
/// requested rate as a measured rate.
fn measured_batch_timing(
    acquisition_started_ns: u64,
    acquisition_finished_ns: u64,
    sample_count: usize,
    previous_acquisition_end_ns: Option<u64>,
) -> BatchTiming {
    let sample_count = u64::try_from(sample_count.max(1)).unwrap_or(u64::MAX);
    let measured_span_ns = previous_acquisition_end_ns
        .filter(|previous| *previous < acquisition_finished_ns)
        .map(|previous| acquisition_finished_ns - previous)
        .unwrap_or_else(|| acquisition_finished_ns.saturating_sub(acquisition_started_ns))
        .max(1);
    let sample_period_ns = (measured_span_ns / sample_count).max(1);
    let start_timestamp_ns = acquisition_finished_ns
        .saturating_sub(sample_period_ns.saturating_mul(sample_count.saturating_sub(1)));
    BatchTiming {
        start_timestamp_ns,
        sample_period_ns,
    }
}

fn elapsed_ns(origin: Instant) -> u64 {
    u64::try_from(origin.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

fn make_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}-{nanos:x}", std::process::id())
}

#[cfg(test)]
mod tests {
    #[test]
    fn high_rate_acquisition_does_not_wait_for_a_coarse_os_timer() {
        assert_eq!(
            super::acquisition_wait(&TargetState::Running, true, 500),
            Duration::ZERO
        );
        assert_eq!(
            super::acquisition_wait(&TargetState::Running, true, 499),
            Duration::from_millis(2)
        );
        assert_eq!(
            super::acquisition_wait(
                &TargetState::Halted {
                    reason: "test".into(),
                },
                true,
                500,
            ),
            Duration::from_millis(2)
        );
    }

    #[test]
    fn high_requested_rate_keeps_slow_probe_batches_responsive() {
        assert_eq!(super::acquisition_frames(100_000, None), 1);
        assert_eq!(super::acquisition_frames(100_000, Some(8_000_000)), 4);
        assert_eq!(super::acquisition_frames(100_000, Some(1_000_000)), 32);
        assert_eq!(super::acquisition_frames(100_000, Some(100_000)), 320);
        assert_eq!(super::acquisition_frames(100_000, Some(1_000)), 800);
        assert_eq!(super::acquisition_frames(5_000, Some(1_000_000)), 32);
        assert_eq!(super::acquisition_frames(20, Some(1_000)), 1);
    }

    use std::{
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use super::*;

    struct StateBackend {
        state: TargetState,
        resume_calls: Arc<AtomicUsize>,
    }

    impl Backend for StateBackend {
        fn name(&self) -> String {
            "state backend".into()
        }

        fn connect(&mut self, _: &ProbeConfig) -> Result<(), String> {
            Ok(())
        }

        fn target_state(&mut self) -> Result<TargetState, String> {
            Ok(self.state.clone())
        }

        fn disconnect(&mut self) {}

        fn halt(&mut self) -> Result<(), String> {
            self.state = TargetState::Halted {
                reason: "pause".into(),
            };
            Ok(())
        }

        fn resume(&mut self) -> Result<(), String> {
            self.resume_calls.fetch_add(1, Ordering::SeqCst);
            self.state = TargetState::Running;
            Ok(())
        }

        fn reset(&mut self) -> Result<(), String> {
            Ok(())
        }

        fn step(&mut self, _: StepKind) -> Result<(), String> {
            Ok(())
        }

        fn set_breakpoints(&mut self, _: &[Breakpoint]) -> Result<(), String> {
            Ok(())
        }

        fn read_registers(&mut self) -> Result<Vec<RegisterValue>, String> {
            Ok(Vec::new())
        }

        fn read_memory(&mut self, _: u64, _: &mut [u8]) -> Result<(), String> {
            Ok(())
        }

        fn write_memory(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
            Ok(())
        }

        fn flash(&mut self, _: &Path, _: bool, _: bool) -> Result<(), String> {
            Ok(())
        }

        fn sample(&mut self, _: &[WatchSpec], _: usize) -> Result<Vec<f64>, String> {
            Ok(Vec::new())
        }
    }

    fn config() -> ProbeConfig {
        ProbeConfig {
            chip: "test-chip".into(),
            selector: Some("auto".into()),
            protocol: "swd".into(),
            speed_khz: 1_000,
            connect_under_reset: false,
        }
    }

    fn state_from(reply: WorkerReply) -> SessionState {
        match reply {
            WorkerReply::State(state) => state,
            other => panic!("expected state reply, got {other:?}"),
        }
    }

    fn collect_rates(
        worker: &WorkerHandle,
        duration: Duration,
    ) -> std::collections::HashMap<String, usize> {
        let deadline = Instant::now() + duration;
        let mut counts = std::collections::HashMap::new();
        let mut last_times = std::collections::HashMap::new();
        let mut last_sequence = 0;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            if let Ok(WorkerEvent::Samples(batch)) = worker.events.recv_timeout(remaining) {
                assert!(batch.batch_sequence > last_sequence);
                last_sequence = batch.batch_sequence;
                assert_eq!(
                    batch.values.len(),
                    batch.channel_ids.len() * batch.sample_count as usize
                );
                for id in batch.channel_ids {
                    if let Some(previous) = last_times.insert(id.clone(), batch.start_timestamp_ns)
                    {
                        assert!(batch.start_timestamp_ns > previous);
                    }
                    *counts.entry(id).or_default() += batch.sample_count as usize;
                }
            }
        }
        counts
    }

    #[test]
    fn mixed_rates_emit_real_separate_batches_and_remove_shared_background_channels() {
        let worker = spawn_worker(crate::MockBackend::default());
        worker.call(WorkerCommand::Connect(config())).unwrap();
        let watch = |id: &str, address| WatchSpec {
            id: id.into(),
            address,
            pointer_address: None,
            pointer_offset: 0,
            byte_width: 4,
            scalar_kind: ScalarKind::Float32,
        };
        let fast = watch("mock.sine", 0x20000000);
        worker
            .call(WorkerCommand::SetSubscriptions {
                watches: vec![fast.clone()],
                requested_hz: 1000,
                background_watches: vec![fast, watch("mock.ramp", 0x20000004)],
                background_hz: 20,
            })
            .unwrap();
        worker.call(WorkerCommand::Resume).unwrap();
        let counts = collect_rates(&worker, Duration::from_millis(600));
        assert!((5..=14).contains(&counts["mock.ramp"]), "{counts:?}");
        assert!(counts["mock.sine"] > counts["mock.ramp"] * 5, "{counts:?}");
        worker.call(WorkerCommand::Halt).unwrap();
        while worker.events.try_recv().is_ok() {}
        assert!(collect_rates(&worker, Duration::from_millis(80)).is_empty());
        worker
            .call(WorkerCommand::SetSubscriptions {
                watches: vec![watch("mock.ramp", 0x20000004)],
                requested_hz: 20,
                background_watches: vec![],
                background_hz: 20,
            })
            .unwrap();
        worker.call(WorkerCommand::Resume).unwrap();
        let counts = collect_rates(&worker, Duration::from_millis(300));
        assert!((3..=7).contains(&counts["mock.ramp"]), "{counts:?}");
        assert!(!counts.contains_key("mock.sine"));
        worker.call(WorkerCommand::Shutdown).unwrap();
    }

    #[test]
    fn connect_reports_running_target_and_resume_does_not_run_it_twice() {
        let resume_calls = Arc::new(AtomicUsize::new(0));
        let worker = spawn_worker(StateBackend {
            state: TargetState::Running,
            resume_calls: resume_calls.clone(),
        });

        let connected = state_from(worker.call(WorkerCommand::Connect(config())).unwrap());
        assert_eq!(connected.target_state, TargetState::Running);

        let resumed = state_from(worker.call_urgent(WorkerCommand::Resume).unwrap());
        assert_eq!(resumed.target_state, TargetState::Running);
        assert_eq!(resumed.stream_epoch, connected.stream_epoch);
        assert_eq!(resume_calls.load(Ordering::SeqCst), 0);

        worker.call_urgent(WorkerCommand::Shutdown).unwrap();
    }

    #[test]
    fn mock_still_connects_halted_and_resumes_normally() {
        let worker = spawn_worker(crate::MockBackend::default());

        let connected = state_from(worker.call(WorkerCommand::Connect(config())).unwrap());
        assert_eq!(
            connected.target_state,
            TargetState::Halted {
                reason: "entry".into()
            }
        );

        let resumed = state_from(worker.call_urgent(WorkerCommand::Resume).unwrap());
        assert_eq!(resumed.target_state, TargetState::Running);
        assert_eq!(resumed.stream_epoch, connected.stream_epoch + 1);

        worker.call_urgent(WorkerCommand::Shutdown).unwrap();
    }

    #[test]
    fn batch_timing_uses_measured_acquisition_duration() {
        let timing = measured_batch_timing(10_000_000, 18_000_000, 2, None);
        assert_eq!(
            timing,
            BatchTiming {
                start_timestamp_ns: 14_000_000,
                sample_period_ns: 4_000_000,
            }
        );
        assert_eq!(
            timing.start_timestamp_ns + timing.sample_period_ns,
            18_000_000
        );
    }

    #[test]
    fn batch_timing_is_monotonic_for_zero_duration_reads() {
        assert_eq!(
            measured_batch_timing(42, 42, 3, None),
            BatchTiming {
                start_timestamp_ns: 40,
                sample_period_ns: 1,
            }
        );
    }

    #[test]
    fn batch_timing_includes_probe_and_scheduler_wall_time() {
        let timing = measured_batch_timing(25_900_000, 26_000_000, 2, Some(18_000_000));
        assert_eq!(
            timing,
            BatchTiming {
                start_timestamp_ns: 22_000_000,
                sample_period_ns: 4_000_000,
            }
        );
    }

    #[test]
    fn polled_halt_ends_stream_and_creates_one_stop_snapshot() {
        let mut state = SessionState {
            target_state: TargetState::Running,
            stop_id: 7,
            stream_epoch: 11,
            revision: 19,
            actual_samples_per_second: 238.5,
            ..Default::default()
        };

        assert!(apply_polled_target_state(
            &mut state,
            TargetState::Halted {
                reason: "breakpoint".into()
            }
        ));
        assert_eq!(state.stop_id, 8);
        assert_eq!(state.stream_epoch, 12);
        assert_eq!(state.revision, 20);
        assert_eq!(state.actual_samples_per_second, 0.0);
        assert_eq!(
            state.target_state,
            TargetState::Halted {
                reason: "breakpoint".into()
            }
        );

        assert!(!apply_polled_target_state(
            &mut state,
            TargetState::Halted {
                reason: "breakpoint".into()
            }
        ));
        assert_eq!(state.stop_id, 8);
    }

    #[test]
    fn polled_lockup_is_a_stop_but_executing_states_are_not() {
        let mut state = SessionState {
            target_state: TargetState::Sleeping,
            ..Default::default()
        };
        assert!(!apply_polled_target_state(&mut state, TargetState::Running));
        assert!(apply_polled_target_state(&mut state, TargetState::LockedUp));
        assert_eq!(state.target_state, TargetState::LockedUp);
        assert_eq!(state.stop_id, 1);
        assert_eq!(state.stream_epoch, 1);
    }

    #[test]
    fn status_polling_backs_off_while_sampling() {
        let now = Instant::now();
        assert_eq!(
            schedule_next_status_poll(now, false).duration_since(now),
            Duration::from_millis(20)
        );
        assert_eq!(
            schedule_next_status_poll(now, true).duration_since(now),
            Duration::from_millis(100)
        );
    }

    #[test]
    fn status_deadline_resets_only_for_state_or_acquisition_transitions() {
        assert!(!status_schedule_changed(
            &TargetState::Running,
            &TargetState::Running,
            true,
            true
        ));
        assert!(status_schedule_changed(
            &TargetState::Halted {
                reason: "entry".into()
            },
            &TargetState::Running,
            true,
            true
        ));
        assert!(status_schedule_changed(
            &TargetState::Running,
            &TargetState::Running,
            false,
            true
        ));
    }
}
