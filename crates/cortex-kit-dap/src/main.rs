mod protocol;

use std::{
    collections::HashMap,
    env, io,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::Engine;
use cortex_kit_core::{
    Expr, ScalarKind, SessionState, SourceIndex, TargetState, VariableDescriptor,
    evaluate_expression, load_rtos_type_layouts, load_elf_data_symbols, load_source_index, load_svd, parse_expression,
    resolve_instruction, resolve_source_line,
};
use cortex_kit_probe::{
    Breakpoint, MockBackend, ProbeConfig, RegisterValue, StepKind, WatchSpec, WorkerCommand,
    WorkerEvent, WorkerHandle, WorkerReply, spawn_worker,
};
use serde_json::{Value, json};

use protocol::{DapReader, DapWriter, start_data_server};

fn main() {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.iter().any(|arg| arg == "--list-probes") {
        println!(
            "{}",
            serde_json::to_string(&cortex_kit_probe::list_probes()).unwrap_or_else(|_| "[]".into())
        );
        return;
    }
    if arguments.iter().any(|arg| arg == "--list-targets") {
        println!(
            "{}",
            serde_json::to_string(&cortex_kit_probe::list_targets())
                .unwrap_or_else(|_| "[]".into())
        );
        return;
    }
    if let Some(index) = arguments.iter().position(|arg| arg == "--inspect-elf") {
        let Some(path) = arguments.get(index + 1) else {
            eprintln!("--inspect-elf requires an ELF/AXF path");
            std::process::exit(2);
        };
        match load_elf_data_symbols(path) {
            Ok(variables) => println!(
                "{}",
                serde_json::to_string_pretty(&variables).unwrap_or_else(|_| "[]".into())
            ),
            Err(error) => {
                eprintln!("failed to inspect {path}: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }
    if let Some(index) = arguments.iter().position(|arg| arg == "--inspect-svd") {
        let Some(path) = arguments.get(index + 1) else {
            eprintln!("--inspect-svd requires an SVD path");
            std::process::exit(2);
        };
        match load_svd(PathBuf::from(path).as_path()) {
            Ok(tree) => println!(
                "{}",
                serde_json::to_string(&tree).unwrap_or_else(|_| "{}".into())
            ),
            Err(error) => {
                eprintln!("failed to inspect {path}: {error:#}");
                std::process::exit(1);
            }
        }
        return;
    }
    let mock = arguments.iter().any(|arg| arg == "--mock");
    let worker = if mock {
        spawn_worker(MockBackend::default())
    } else {
        spawn_worker(cortex_kit_probe::ProbeRsBackend::default())
    };
    if let Err(error) = serve(worker, mock) {
        eprintln!("Cortex Kit DAP stopped: {error}");
    }
}

fn serve(worker: WorkerHandle, mock: bool) -> Result<(), String> {
    let stdout = Arc::new(Mutex::new(DapWriter::new(io::stdout())));
    let state = Arc::new(Mutex::new(SessionState::default()));
    let (data_info, sample_tx) = start_data_server().map_err(|error| error.to_string())?;
    let event_rx = worker.events.clone();
    let event_stdout = stdout.clone();
    let event_state = state.clone();
    std::thread::spawn(move || {
        let mut transport_dropped_frames = 0_u64;
        while let Ok(event) = event_rx.recv() {
            match event {
                WorkerEvent::State {
                    state: next,
                    spontaneous_stop,
                } => {
                    let stopped = spontaneous_stopped_body(&next, spontaneous_stop);
                    *event_state.lock().unwrap() = next.clone();
                    let _ = emit(&event_stdout, "cortexKit.state", json!(next));
                    if let Some(body) = stopped {
                        let _ = emit(&event_stdout, "stopped", body);
                    }
                }
                WorkerEvent::Samples(mut batch) => {
                    batch.dropped_frames = batch
                        .dropped_frames
                        .saturating_add(transport_dropped_frames);
                    if let Err(error) = sample_tx.try_send(batch) {
                        transport_dropped_frames = transport_dropped_frames
                            .saturating_add(u64::from(error.into_inner().sample_count));
                    }
                }
                WorkerEvent::Error(error) => {
                    let _ = emit(
                        &event_stdout,
                        "output",
                        json!({"category":"stderr", "output":format!("Cortex Kit: {error}\n")}),
                    );
                }
            }
        }
    });

    let catalog = Arc::new(Mutex::new(worker.catalog().to_vec()));
    let sources = Arc::new(Mutex::new(SourceIndex::default()));
    let rtos_layouts = Arc::new(Mutex::new(Vec::<VariableDescriptor>::new()));
    let breakpoint_sets = Arc::new(Mutex::new(HashMap::<String, Vec<u64>>::new()));
    let mut reader = DapReader::new(io::stdin());
    let mut launched = false;
    let mut stop_on_entry = true;
    let mut plot_only = false;
    let mut initialized_sent = false;
    while let Some(request) = reader.next_message().map_err(|error| error.to_string())? {
        if request.kind != "request" {
            continue;
        }
        let command = request.command.clone().unwrap_or_default();
        let arguments = request.arguments.clone().unwrap_or(Value::Null);
        let response = handle_request(
            &worker,
            &state,
            &catalog,
            &sources,
            &rtos_layouts,
            &breakpoint_sets,
            mock,
            &command,
            &arguments,
            &mut launched,
            &mut stop_on_entry,
            &mut plot_only,
        );
        match response {
            Ok(body) => {
                stdout
                    .lock()
                    .unwrap()
                    .response(&request, true, body, None)
                    .map_err(|error| error.to_string())?;
                match command.as_str() {
                    "launch" | "attach" => {
                        if !initialized_sent {
                            emit(&stdout, "initialized", json!({}))?;
                            initialized_sent = true;
                        }
                        emit(
                            &stdout,
                            "cortexKit.catalog",
                            json!({"variables":catalog.lock().unwrap().clone()}),
                        )?;
                        emit(&stdout, "cortexKit.dataChannelReady", json!(data_info))?;
                        if stop_on_entry {
                            emit(
                                &stdout,
                                "stopped",
                                json!({"reason":"entry", "threadId":1, "allThreadsStopped":true}),
                            )?;
                        }
                    }
                    "continue" => emit(
                        &stdout,
                        "continued",
                        json!({"threadId":1, "allThreadsContinued":true}),
                    )?,
                    "pause" => emit(
                        &stdout,
                        "stopped",
                        json!({"reason":"pause", "threadId":1, "allThreadsStopped":true}),
                    )?,
                    "next" | "stepIn" | "stepOut" | "restart" => emit(
                        &stdout,
                        "stopped",
                        json!({"reason":"step", "threadId":1, "allThreadsStopped":true}),
                    )?,
                    "disconnect" | "terminate" => {
                        emit(&stdout, "terminated", json!({}))?;
                        break;
                    }
                    _ => {}
                }
            }
            Err(error) => stdout
                .lock()
                .unwrap()
                .response(&request, false, Value::Null, Some(error))
                .map_err(|write_error| write_error.to_string())?,
        }
    }
    let _ = worker.call_urgent(WorkerCommand::Shutdown);
    Ok(())
}

fn handle_request(
    worker: &WorkerHandle,
    state: &Arc<Mutex<SessionState>>,
    catalog: &Arc<Mutex<Vec<VariableDescriptor>>>,
    sources: &Arc<Mutex<SourceIndex>>,
    rtos_layouts: &Arc<Mutex<Vec<VariableDescriptor>>>,
    breakpoint_sets: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
    mock: bool,
    command: &str,
    arguments: &Value,
    launched: &mut bool,
    stop_on_entry: &mut bool,
    plot_only: &mut bool,
) -> Result<Value, String> {
    match command {
        "initialize" => Ok(
            json!({"supportsConfigurationDoneRequest":true,"supportsTerminateRequest":true,"supportsRestartRequest":true,"supportsInstructionBreakpoints":true,"supportsReadMemoryRequest":true,"supportsWriteMemoryRequest":true,"supportsDisassembleRequest":true,"supportsSetVariable":true,"supportsSetExpression":true,"supportsEvaluateForHovers":true}),
        ),
        "launch" | "attach" => {
            let requested_plot_only = arguments
                .get("plotOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if requested_plot_only && command != "attach" {
                return Err("plotOnly is only supported with request: attach".into());
            }
            let chip = arguments
                .get("chip")
                .and_then(Value::as_str)
                .unwrap_or(if mock { "Cortex-M Mock" } else { "" });
            if chip.is_empty() {
                return Err("chip is required for a hardware session".into());
            }
            let probe = arguments.get("probe").cloned().unwrap_or(Value::Null);
            let config = parse_probe_config(chip, &probe);
            let next = expect_state(worker.call(WorkerCommand::Connect(config))?)?;
            *state.lock().unwrap() = next;
            rtos_layouts.lock().unwrap().clear();
            if !mock {
                if let Some(program) = arguments.get("programBinary").and_then(Value::as_str) {
                    if matches!(
                        PathBuf::from(program)
                            .extension()
                            .and_then(|value| value.to_str())
                            .map(str::to_ascii_lowercase)
                            .as_deref(),
                        Some("elf" | "axf" | "out")
                    ) {
                        *rtos_layouts.lock().unwrap() = load_rtos_type_layouts(program).unwrap_or_default();
                        if let Ok(variables) = load_elf_data_symbols(program) {
                            *catalog.lock().unwrap() = variables;
                        }
                        if let Ok(index) = load_source_index(PathBuf::from(program).as_path()) {
                            *sources.lock().unwrap() = index;
                        }
                    }
                }
            }
            if command == "launch"
                && arguments
                    .pointer("/flashing/enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                if let Some(program) = arguments.get("programBinary").and_then(Value::as_str) {
                    let verify = arguments
                        .pointer("/flashing/verify")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    let reset_after = arguments
                        .pointer("/flashing/resetAfter")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    let next = expect_state(worker.call_urgent(WorkerCommand::Flash {
                        path: PathBuf::from(program),
                        verify,
                        reset_after,
                    })?)?;
                    *state.lock().unwrap() = next;
                }
            }
            *launched = true;
            *plot_only = requested_plot_only;
            *stop_on_entry = arguments
                .get("stopOnEntry")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(json!({}))
        }
        "configurationDone" => {
            if *launched && !*stop_on_entry {
                *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Resume)?)?;
            }
            Ok(json!({}))
        }
        "disconnect" | "terminate" => {
            if *launched {
                let _ = worker.call_urgent(WorkerCommand::Disconnect);
            }
            Ok(json!({}))
        }
        "continue" => {
            *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Resume)?)?;
            Ok(json!({"allThreadsContinued":true}))
        }
        "pause" => {
            *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Halt)?)?;
            Ok(json!({}))
        }
        "next" => {
            require_debug_control(*plot_only, "step over")?;
            step(worker, state, StepKind::Over)
        }
        "stepIn" => {
            require_debug_control(*plot_only, "step in")?;
            step(worker, state, StepKind::In)
        }
        "stepOut" => {
            require_debug_control(*plot_only, "step out")?;
            step(worker, state, StepKind::Out)
        }
        "restart" => {
            require_debug_control(*plot_only, "restart/reset")?;
            *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Reset)?)?;
            Ok(json!({}))
        }
        "threads" => Ok(json!({"threads":[{"id":1,"name":"Cortex-M core 0"}]})),
        "stackTrace" => stack_trace_response(worker, &sources.lock().unwrap()),
        "scopes" => Ok(
            json!({"scopes":[{"name":"Locals","variablesReference":1,"expensive":false},{"name":"Statics","variablesReference":2,"expensive":false},{"name":"CPU Registers","variablesReference":3,"expensive":false}]}),
        ),
        "variables" if arguments.get("variablesReference").and_then(Value::as_i64) == Some(3) => {
            match worker.call(WorkerCommand::ReadRegisters)? {
                WorkerReply::Registers(registers) => Ok(
                    json!({"variables":registers.into_iter().map(|register| json!({"name":register.name,"value":register.value,"type":"register","variablesReference":0})).collect::<Vec<_>>() }),
                ),
                _ => Err("unexpected register reply".into()),
            }
        }
        "variables" if arguments.get("variablesReference").and_then(Value::as_i64)
            .is_some_and(|reference| reference == 2 || reference >= 4) => {
            static_variables_response(worker, &catalog.lock().unwrap(), arguments)
        }
        "variables" => variables_response(&catalog.lock().unwrap(), arguments),
        "evaluate" => evaluate(worker, &catalog.lock().unwrap(), arguments),
        "setVariable" => {
            require_debug_control(*plot_only, "variable write")?;
            let catalog = catalog.lock().unwrap();
            let name = arguments.get("name").and_then(Value::as_str).unwrap_or_default();
            let reference = arguments.get("variablesReference").and_then(Value::as_u64).unwrap_or(2);
            let mut containers = Vec::new();
            collect_variable_containers(&catalog, &mut containers);
            let children = if reference == 2 { catalog.as_slice() } else {
                &containers.get(reference.checked_sub(4).ok_or("invalid variable reference")? as usize)
                    .ok_or("unknown variable reference")?.children
            };
            let variable = children.iter().find(|item| item.name == name || item.expression == name)
                .ok_or_else(|| format!("unknown child variable: {name}"))?;
            set_named_value_with_auto_pause(
                worker,
                state,
                &catalog,
                &variable.id,
                arguments
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        }
        "setExpression" => {
            require_debug_control(*plot_only, "expression write")?;
            set_named_value_with_auto_pause(
                worker,
                state,
                &catalog.lock().unwrap(),
                arguments
                    .get("expression")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                arguments
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
        }
        "setBreakpoints" => {
            let path = arguments
                .pointer("/source/path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let requested = arguments
                .get("breakpoints")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if *plot_only {
                return Ok(
                    json!({"breakpoints":requested.iter().enumerate().map(|(index, item)| json!({
                    "id":index+1,
                    "verified":false,
                    "line":item.get("line"),
                    "message":"Disabled by Cortex Kit plot-only mode"
                })).collect::<Vec<_>>() }),
                );
            }
            let source_index = sources.lock().unwrap();
            let resolved = requested
                .iter()
                .map(|item| {
                    item.get("line")
                        .and_then(Value::as_u64)
                        .and_then(|line| resolve_source_line(&source_index, path, line))
                })
                .collect::<Vec<_>>();
            drop(source_index);
            breakpoint_sets.lock().unwrap().insert(
                format!("source:{path}"),
                resolved.iter().flatten().map(|line| line.address).collect(),
            );
            install_breakpoints(worker, breakpoint_sets)?;
            Ok(
                json!({"breakpoints":resolved.into_iter().enumerate().map(|(index, line)| match line {
                Some(line) => json!({"id":index+1,"verified":true,"line":line.line,"instructionReference":format!("0x{:08x}",line.address)}),
                None if mock => json!({"id":index+1,"verified":true,"line":requested[index].get("line")}),
                None => json!({"id":index+1,"verified":false,"message":"No unique executable DWARF row found"}),
            }).collect::<Vec<_>>() }),
            )
        }
        "setInstructionBreakpoints" => {
            if *plot_only {
                let requested = arguments
                    .get("breakpoints")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                return Ok(
                    json!({"breakpoints":requested.iter().enumerate().map(|(index, item)| json!({
                    "id":index+1,
                    "verified":false,
                    "instructionReference":item.get("instructionReference"),
                    "message":"Disabled by Cortex Kit plot-only mode"
                })).collect::<Vec<_>>() }),
                );
            }
            let items: Vec<Breakpoint> = arguments
                .get("breakpoints")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    item.get("instructionReference")
                        .and_then(Value::as_str)
                        .and_then(parse_address)
                        .map(|address| Breakpoint { address })
                })
                .collect();
            breakpoint_sets.lock().unwrap().insert(
                "instruction".into(),
                items.iter().map(|item| item.address).collect(),
            );
            install_breakpoints(worker, breakpoint_sets)?;
            Ok(
                json!({"breakpoints":items.iter().enumerate().map(|(index, item)| json!({"id":index+1,"verified":true,"instructionReference":format!("0x{:08x}",item.address)})).collect::<Vec<_>>() }),
            )
        }
        "readMemory" => {
            let address = arguments
                .get("memoryReference")
                .and_then(Value::as_str)
                .and_then(parse_address)
                .ok_or_else(|| "invalid memoryReference".to_owned())?
                + arguments.get("offset").and_then(Value::as_i64).unwrap_or(0) as u64;
            let count = arguments.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
            match worker.call(WorkerCommand::ReadMemory {
                address,
                length: count,
            })? {
                WorkerReply::Memory(bytes) => Ok(
                    json!({"address":format!("0x{address:x}"),"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
                ),
                _ => Err("unexpected worker reply".into()),
            }
        }
        "writeMemory" => {
            require_debug_control(*plot_only, "memory write")?;
            let address = arguments
                .get("memoryReference")
                .and_then(Value::as_str)
                .and_then(parse_address)
                .ok_or_else(|| "invalid memoryReference".to_owned())?
                + arguments.get("offset").and_then(Value::as_i64).unwrap_or(0) as u64;
            let data = base64::engine::general_purpose::STANDARD
                .decode(
                    arguments
                        .get("data")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                .map_err(|error| error.to_string())?;
            let count = data.len();
            let (_, auto_paused) = with_auto_pause(worker, state, || {
                worker.call(WorkerCommand::WriteMemory { address, data })
            })?;
            Ok(json!({"bytesWritten":count,"autoPaused":auto_paused}))
        }
        "disassemble" => {
            let address = arguments
                .get("memoryReference")
                .and_then(Value::as_str)
                .and_then(parse_address)
                .unwrap_or(0);
            let count = arguments
                .get("instructionCount")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            Ok(
                json!({"instructions":(0..count).map(|index| json!({"address":format!("0x{:08x}",address+index*2),"instructionBytes":"00bf","instruction":"nop"})).collect::<Vec<_>>() }),
            )
        }
        "cortexKit/getState" => Ok(json!(state.lock().unwrap().clone())),
        "cortexKit/getRtosLayouts" => Ok(json!({"layouts":rtos_layouts.lock().unwrap().clone()})),
        "cortexKit/getCatalog" => Ok(json!({"variables":catalog.lock().unwrap().clone()})),
        "cortexKit/readValues" => {
            let descriptors = catalog.lock().unwrap();
            let selected = arguments
                .get("ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|id| find_variable(&descriptors, id).cloned())
                .collect::<Vec<_>>();
            read_descriptor_values(worker, selected)
        }
        "cortexKit/writeValue" => set_named_value_with_auto_pause(
            worker,
            state,
            &catalog.lock().unwrap(),
            arguments
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            arguments
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        "cortexKit/readRegisters" => {
            let watches = arguments
                .get("registers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_owned();
                    let address = item.get("address").and_then(|value| {
                        value
                            .as_str()
                            .and_then(parse_address)
                            .or_else(|| value.as_u64())
                    })?;
                    let size_bits = item.get("sizeBits").and_then(Value::as_u64).unwrap_or(32);
                    Some(WatchSpec {
                        id,
                        address,
                        pointer_address: None,
                        pointer_offset: 0,
                        byte_width: size_bits.div_ceil(8).clamp(1, 8) as u8,
                        scalar_kind: ScalarKind::Unsigned,
                    })
                })
                .collect::<Vec<_>>();
            let values = match worker.call(WorkerCommand::ReadValues(watches.clone()))? {
                WorkerReply::Values(values) => values,
                _ => return Err("unexpected register-value reply".into()),
            };
            Ok(
                json!({"values":watches.into_iter().zip(values).map(|(watch, value)| json!({"id":watch.id,"address":watch.address,"value":value})).collect::<Vec<_>>() }),
            )
        }
        "cortexKit/setSubscriptions" => {
            let requested_hz = arguments
                .get("requestedSamplesPerSecond")
                .and_then(Value::as_u64)
                .unwrap_or(1_000) as u32;
            let descriptors = catalog.lock().unwrap();
            let resolve_watches = |key: &str| -> Vec<WatchSpec> {
                arguments
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter_map(|id| find_variable(&descriptors, id))
                    .filter(|item| is_addressable(item))
                    .map(watch_for)
                    .collect()
            };
            let watches = resolve_watches("ids");
            let background_watches = resolve_watches("backgroundIds");
            let background_hz = arguments
                .get("backgroundSamplesPerSecond")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 1_000) as u32;
            drop(descriptors);
            let (_, auto_paused) = with_auto_pause(worker, state, || {
                worker.call(WorkerCommand::SetSubscriptions {
                    watches,
                    requested_hz,
                    background_watches,
                    background_hz,
                })
            })?;
            Ok(json!({"autoPaused":auto_paused}))
        }
        "cortexKit/flash" => {
            require_debug_control(*plot_only, "flash")?;
            let path = arguments
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "flash path is required".to_owned())?;
            let verify = arguments
                .get("verify")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let reset_after = arguments
                .get("resetAfter")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Flash {
                path: PathBuf::from(path),
                verify,
                reset_after,
            })?)?;
            Ok(json!({}))
        }
        "cortexKit/benchmark" => {
            let seconds = arguments
                .get("seconds")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .clamp(0.1, 10.0);
            match worker.call(WorkerCommand::Benchmark {
                duration: Duration::from_secs_f64(seconds),
            })? {
                WorkerReply::Benchmark(stats) => Ok(json!(stats)),
                _ => Err("unexpected worker reply".into()),
            }
        }
        _ => Err(format!("unsupported request: {command}")),
    }
}

fn require_debug_control(plot_only: bool, operation: &str) -> Result<(), String> {
    if plot_only {
        Err(format!(
            "{operation} is disabled by Cortex Kit plot-only mode; disconnect and use a normal debug configuration to modify target state"
        ))
    } else {
        Ok(())
    }
}

fn parse_probe_config(chip: &str, probe: &Value) -> ProbeConfig {
    ProbeConfig {
        chip: chip.into(),
        selector: probe
            .get("selector")
            .and_then(Value::as_str)
            .map(str::to_owned),
        protocol: probe
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("swd")
            .into(),
        speed_khz: probe
            .get("speedKHz")
            .and_then(Value::as_u64)
            .unwrap_or(10_000) as u32,
        connect_under_reset: probe
            .get("connectUnderReset")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn step(
    worker: &WorkerHandle,
    state: &Arc<Mutex<SessionState>>,
    kind: StepKind,
) -> Result<Value, String> {
    *state.lock().unwrap() = expect_state(worker.call_urgent(WorkerCommand::Step(kind))?)?;
    Ok(json!({}))
}
fn expect_state(reply: WorkerReply) -> Result<SessionState, String> {
    match reply {
        WorkerReply::State(state) => Ok(state),
        _ => Err("unexpected worker state reply".into()),
    }
}
fn parse_address(value: &str) -> Option<u64> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16)
        .ok()
        .or_else(|| value.parse().ok())
}

fn stack_trace_response(worker: &WorkerHandle, sources: &SourceIndex) -> Result<Value, String> {
    let registers = match worker.call(WorkerCommand::ReadRegisters)? {
        WorkerReply::Registers(registers) => registers,
        _ => return Err("unexpected register reply while building stack trace".into()),
    };
    let address = program_counter(&registers).unwrap_or(0x0800_0000);
    let frame = if let Some(row) = resolve_instruction(sources, address) {
        let source_path = if cfg!(windows) {
            row.path.replace('/', "\\")
        } else {
            row.path.clone()
        };
        let source_name = PathBuf::from(&source_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&source_path)
            .to_owned();
        json!({
            "id":1,
            "name":format!("{}:{}", source_name, row.line),
            "source":{"name":source_name,"path":source_path},
            "line":row.line,
            "column":1,
            "instructionPointerReference":format!("0x{address:08x}")
        })
    } else {
        json!({
            "id":1,
            "name":format!("0x{address:08x}"),
            "line":1,
            "column":1,
            "instructionPointerReference":format!("0x{address:08x}")
        })
    };
    Ok(json!({"stackFrames":[frame],"totalFrames":1}))
}

fn program_counter(registers: &[RegisterValue]) -> Option<u64> {
    registers.iter().find_map(|register| {
        let name = register.name.to_ascii_lowercase();
        ((name == "pc") || (name == "r15") || name.contains("/pc") || name.contains("pc/"))
            .then(|| parse_address(&register.value))
            .flatten()
    })
}

fn read_descriptor_values(
    worker: &WorkerHandle,
    descriptors: Vec<VariableDescriptor>,
) -> Result<Value, String> {
    let watches = descriptors
        .iter()
        .filter(|item| is_addressable(item))
        .map(watch_for)
        .collect::<Vec<_>>();
    let values = match worker.call(WorkerCommand::ReadValues(watches.clone()))? {
        WorkerReply::Values(values) => values,
        _ => return Err("unexpected variable-value reply".into()),
    };
    Ok(
        json!({"values":watches.into_iter().zip(values).map(|(watch, value)| json!({"id":watch.id,"value":value})).collect::<Vec<_>>() }),
    )
}

fn install_breakpoints(
    worker: &WorkerHandle,
    breakpoint_sets: &Arc<Mutex<HashMap<String, Vec<u64>>>>,
) -> Result<(), String> {
    let mut addresses = breakpoint_sets
        .lock()
        .unwrap()
        .values()
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    worker.call(WorkerCommand::SetBreakpoints(
        addresses
            .into_iter()
            .map(|address| Breakpoint { address })
            .collect(),
    ))?;
    Ok(())
}

fn variables_response(catalog: &[VariableDescriptor], arguments: &Value) -> Result<Value, String> {
    let reference = arguments
        .get("variablesReference")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let values = match reference {
        1 => vec![json!({"name":"tick","value":"0","type":"uint32_t","variablesReference":0,"memoryReference":"0x20000010"})],
        2 => catalog.iter().map(|item| json!({"name":item.name,"evaluateName":item.expression,"value":"0","type":item.type_name,"variablesReference":0,"memoryReference":item.address.map(|address| format!("0x{address:x}"))})).collect(),
        3 => vec![json!({"name":"r0","value":"0x00000000","type":"uint32_t","variablesReference":0}),json!({"name":"pc","value":"0x08000000","type":"uint32_t","variablesReference":0}),json!({"name":"xPSR","value":"0x01000000","type":"uint32_t","variablesReference":0})],
        _ => Vec::new(),
    };
    Ok(json!({"variables":values}))
}

fn static_variables_response(
    worker: &WorkerHandle,
    catalog: &[VariableDescriptor],
    arguments: &Value,
) -> Result<Value, String> {
    let mut containers = Vec::new();
    collect_variable_containers(catalog, &mut containers);
    let reference = arguments.get("variablesReference").and_then(Value::as_u64).unwrap_or(2);
    let children = if reference == 2 { catalog } else {
        &containers.get(reference.saturating_sub(4) as usize)
            .ok_or_else(|| format!("unknown variable reference: {reference}"))?.children
    };
    let descriptors = children.iter().filter(|item| {
        match arguments.get("filter").and_then(Value::as_str) {
            Some("indexed") => item.name.starts_with('['),
            Some("named") => !item.name.starts_with('['),
            _ => true,
        }
    }).skip(arguments.get("start").and_then(Value::as_u64).unwrap_or(0) as usize)
        .take(arguments.get("count").and_then(Value::as_u64).filter(|count| *count > 0)
            .unwrap_or(usize::MAX as u64) as usize).collect::<Vec<_>>();
    let watches = descriptors
        .iter()
        .filter(|item| item.children.is_empty() && is_addressable(item) && matches!(item.byte_width, 1 | 2 | 4 | 8))
        .map(|item| watch_for(item))
        .collect::<Vec<_>>();
    let values = if watches.is_empty() { Vec::new() } else { match worker.call(WorkerCommand::ReadValues(watches))? {
        WorkerReply::Values(values) => values,
        _ => return Err("unexpected static value reply".into()),
    }};
    let references = containers.iter().enumerate().map(|(index, item)| (item.id.as_str(), index + 4)).collect::<HashMap<_, _>>();
    let mut values = values.into_iter();
    Ok(json!({"variables":descriptors.into_iter().map(|item| {
        let value = if !item.children.is_empty() { format!("{} {{…}}", item.type_name) }
            else if is_addressable(item) && matches!(item.byte_width, 1 | 2 | 4 | 8) {
                values.next().map(|value| format_scalar(value, item.scalar_kind)).unwrap_or_else(|| "<unavailable>".into())
            } else { "<unavailable>".into() };
        json!({
            "name":item.name,
            "evaluateName":item.expression,
            "value":value,
            "type":item.type_name,
            "variablesReference":references.get(item.id.as_str()).copied().unwrap_or(0),
            "namedVariables":item.children.iter().filter(|child| !child.name.starts_with('[')).count(),
            "indexedVariables":item.children.iter().filter(|child| child.name.starts_with('[')).count(),
            "memoryReference":item.address.map(|address| format!("0x{address:x}")),
        })
    }).collect::<Vec<_>>() }))
}

fn evaluate(
    worker: &WorkerHandle,
    catalog: &[VariableDescriptor],
    arguments: &Value,
) -> Result<Value, String> {
    let source = arguments
        .get("expression")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(item) = find_variable(catalog, source).filter(|item| !item.children.is_empty()) {
        let mut containers = Vec::new();
        collect_variable_containers(catalog, &mut containers);
        let reference = containers.iter().position(|container| container.id == item.id).unwrap() + 4;
        return Ok(json!({
            "result":format!("{} {{…}}", item.type_name), "type":item.type_name,
            "variablesReference":reference,
            "namedVariables":item.children.iter().filter(|child| !child.name.starts_with('[')).count(),
            "indexedVariables":item.children.iter().filter(|child| child.name.starts_with('[')).count(),
            "memoryReference":item.address.map(|address| format!("0x{address:x}")),
        }));
    }
    let expression = parse_expression(source).map_err(|error| error.to_string())?;
    let mut names = Vec::new();
    collect_expression_names(&expression, &mut names);
    names.sort();
    names.dedup();
    let descriptors = names
        .iter()
        .map(|name| find_variable(catalog, name).ok_or_else(|| format!("unknown variable: {name}")))
        .collect::<Result<Vec<_>, _>>()?;
    let samples = match worker.call(WorkerCommand::ReadValues(
        descriptors.iter().map(|item| watch_for(item)).collect(),
    ))? {
        WorkerReply::Values(values) => values,
        _ => return Err("unexpected evaluate reply".into()),
    };
    let values = descriptors
        .into_iter()
        .zip(samples)
        .map(|(item, value)| (item.expression.clone(), value))
        .collect();
    let value = evaluate_expression(&expression, &values).map_err(|error| error.to_string())?;
    Ok(json!({"result":value.to_string(),"variablesReference":0,"type":"number"}))
}

fn set_named_value(
    worker: &WorkerHandle,
    catalog: &[VariableDescriptor],
    name: &str,
    source: &str,
) -> Result<Value, String> {
    let item = find_variable(catalog, name).ok_or_else(|| format!("unknown variable: {name}"))?;
    if !item.writable {
        return Err(format!("{} is read-only", item.name));
    }
    let address = resolve_descriptor_address(worker, item)?;
    let (bytes, requested_value) = encode_scalar_source(source, item.scalar_kind, item.byte_width)?;
    let readback = match worker.call(WorkerCommand::WriteMemoryVerified {
        address,
        data: bytes.clone(),
    })? {
        WorkerReply::Memory(bytes) => bytes,
        _ => return Err("unexpected verified-write reply".into()),
    };
    let numeric_value = decode_scalar_bytes(&readback, item.scalar_kind)?;
    let value = format_scalar_bytes(&readback, item.scalar_kind)?;
    Ok(json!({
        "value": value,
        "numericValue": numeric_value,
        "requestedValue": requested_value,
        "verified": readback == bytes,
        "type": item.type_name,
        "variablesReference": 0
    }))
}

fn set_named_value_with_auto_pause(
    worker: &WorkerHandle,
    state: &Arc<Mutex<SessionState>>,
    catalog: &[VariableDescriptor],
    name: &str,
    source: &str,
) -> Result<Value, String> {
    let (mut response, auto_paused) = with_auto_pause(worker, state, || {
        set_named_value(worker, catalog, name, source)
    })?;
    if let Some(object) = response.as_object_mut() {
        object.insert("autoPaused".into(), Value::Bool(auto_paused));
    }
    Ok(response)
}

fn with_auto_pause<T>(
    worker: &WorkerHandle,
    state: &Arc<Mutex<SessionState>>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<(T, bool), String> {
    let should_resume = matches!(
        state.lock().unwrap().target_state,
        TargetState::Running | TargetState::Sleeping
    );
    if should_resume {
        let halted = expect_state(worker.call_urgent(WorkerCommand::Halt)?)?;
        *state.lock().unwrap() = halted;
    }

    let operation_result = operation();
    let resume_result = if should_resume {
        worker
            .call_urgent(WorkerCommand::Resume)
            .and_then(expect_state)
            .map(|running| *state.lock().unwrap() = running)
    } else {
        Ok(())
    };

    match (operation_result, resume_result) {
        (Ok(value), Ok(())) => Ok((value, should_resume)),
        (Err(operation), Ok(())) => Err(operation),
        (Ok(_), Err(resume)) => Err(format!(
            "operation completed, but target resume failed: {resume}"
        )),
        (Err(operation), Err(resume)) => Err(format!(
            "{operation}; additionally, target resume failed: {resume}"
        )),
    }
}

fn watch_for(item: &VariableDescriptor) -> WatchSpec {
    WatchSpec {
        id: item.id.clone(),
        address: item.address.unwrap_or_default(),
        pointer_address: item.pointer_address,
        pointer_offset: item.pointer_offset.unwrap_or_default(),
        byte_width: item.byte_width,
        scalar_kind: item.scalar_kind,
    }
}

fn resolve_descriptor_address(worker: &WorkerHandle, item: &VariableDescriptor) -> Result<u64, String> {
    if let Some(address) = item.address { return Ok(address); }
    let pointer_address = item.pointer_address
        .ok_or_else(|| "expression has no writable address".to_owned())?;
    let bytes = match worker.call(WorkerCommand::ReadMemory { address: pointer_address, length: 4 })? {
        WorkerReply::Memory(bytes) => bytes,
        _ => return Err("unexpected pointer read reply".into()),
    };
    let bytes: [u8; 4] = bytes.try_into().map_err(|_| "pointer read returned the wrong width")?;
    let base = u64::from(u32::from_le_bytes(bytes));
    if base == 0 { return Err(format!("pointer at 0x{pointer_address:08x} is null")); }
    Ok(base.saturating_add(item.pointer_offset.unwrap_or_default()))
}

fn is_addressable(item: &VariableDescriptor) -> bool {
    item.address.is_some() || item.pointer_address.is_some()
}

fn find_variable<'a>(
    catalog: &'a [VariableDescriptor],
    query: &str,
) -> Option<&'a VariableDescriptor> {
    for item in catalog {
        if item.id == query || item.name == query || item.expression == query {
            return Some(item);
        }
        if let Some(found) = find_variable(&item.children, query) {
            return Some(found);
        }
    }
    None
}

fn collect_variable_containers<'a>(
    catalog: &'a [VariableDescriptor],
    output: &mut Vec<&'a VariableDescriptor>,
) {
    for item in catalog {
        if !item.children.is_empty() {
            output.push(item);
            collect_variable_containers(&item.children, output);
        }
    }
}
fn format_scalar(value: f64, kind: ScalarKind) -> String {
    match kind {
        ScalarKind::Float32 | ScalarKind::Float64 => format!("{value:.8}"),
        ScalarKind::Boolean => (value != 0.0).to_string(),
        ScalarKind::Signed => format!("{} (0x{:X})", value as i64, value as i64),
        ScalarKind::Unsigned => format!("{} (0x{:X})", value as u64, value as u64),
    }
}
fn decode_scalar_bytes(bytes: &[u8], kind: ScalarKind) -> Result<f64, String> {
    let mut raw = [0_u8; 8];
    if bytes.is_empty() || bytes.len() > raw.len() {
        return Err(format!("invalid scalar width: {}", bytes.len()));
    }
    raw[..bytes.len()].copy_from_slice(bytes);
    Ok(match kind {
        ScalarKind::Float32 if bytes.len() == 4 => {
            f32::from_le_bytes(raw[..4].try_into().unwrap()) as f64
        }
        ScalarKind::Float64 if bytes.len() == 8 => f64::from_le_bytes(raw),
        ScalarKind::Float32 | ScalarKind::Float64 => {
            return Err(format!("invalid floating-point width: {}", bytes.len()));
        }
        ScalarKind::Signed => {
            let shift = (8 - bytes.len()) * 8;
            ((i64::from_le_bytes(raw) << shift) >> shift) as f64
        }
        ScalarKind::Boolean => u8::from(raw[..bytes.len()].iter().any(|byte| *byte != 0)) as f64,
        ScalarKind::Unsigned => u64::from_le_bytes(raw) as f64,
    })
}
fn format_scalar_bytes(bytes: &[u8], kind: ScalarKind) -> Result<String, String> {
    let numeric = decode_scalar_bytes(bytes, kind)?;
    let encoded = bytes
        .iter()
        .rev()
        .fold(0_u128, |result, byte| (result << 8) | u128::from(*byte));
    Ok(match kind {
        ScalarKind::Float32 => format!("{numeric:.8}"),
        ScalarKind::Float64 => format!("{numeric:.12}"),
        ScalarKind::Boolean => (encoded != 0).to_string(),
        ScalarKind::Signed => {
            let bits = bytes.len() * 8;
            let signed = if encoded & (1_u128 << (bits - 1)) == 0 {
                encoded as i128
            } else {
                encoded as i128 - (1_i128 << bits)
            };
            format!("{signed} (0x{encoded:0digits$X})", digits = bytes.len() * 2)
        }
        ScalarKind::Unsigned => {
            format!(
                "{encoded} (0x{encoded:0digits$X})",
                digits = bytes.len() * 2
            )
        }
    })
}
fn encode_scalar_source(
    source: &str,
    kind: ScalarKind,
    width: u8,
) -> Result<(Vec<u8>, String), String> {
    let width = usize::from(width);
    match kind {
        ScalarKind::Float32 if width == 4 => {
            let value = source
                .trim()
                .parse::<f32>()
                .map_err(|error| error.to_string())?;
            if !value.is_finite() {
                return Err("floating-point value must be finite".into());
            }
            Ok((value.to_le_bytes().to_vec(), format!("{value:.8}")))
        }
        ScalarKind::Float64 if width == 8 => {
            let value = source
                .trim()
                .parse::<f64>()
                .map_err(|error| error.to_string())?;
            if !value.is_finite() {
                return Err("floating-point value must be finite".into());
            }
            Ok((value.to_le_bytes().to_vec(), format!("{value:.12}")))
        }
        ScalarKind::Boolean if matches!(width, 1 | 2 | 4 | 8) => match source.trim() {
            "true" | "1" => {
                let mut bytes = vec![0; width];
                bytes[0] = 1;
                Ok((bytes, "true".into()))
            }
            "false" | "0" => Ok((vec![0; width], "false".into())),
            _ => Err("expected true, false, 0 or 1".into()),
        },
        ScalarKind::Signed if matches!(width, 1 | 2 | 4 | 8) => {
            let value = parse_signed_integer(source)?;
            let bits = width * 8;
            let min = -(1_i128 << (bits - 1));
            let max = (1_i128 << (bits - 1)) - 1;
            if value < min || value > max {
                return Err(format!("value is outside the signed {bits}-bit range"));
            }
            let bytes = value.to_le_bytes()[..width].to_vec();
            let encoded = bytes
                .iter()
                .rev()
                .fold(0_u128, |result, byte| (result << 8) | u128::from(*byte));
            Ok((
                bytes,
                format!("{value} (0x{encoded:0digits$X})", digits = width * 2),
            ))
        }
        ScalarKind::Unsigned if matches!(width, 1 | 2 | 4 | 8) => {
            let value = parse_unsigned_integer(source)?;
            let bits = width * 8;
            let max = (1_u128 << bits) - 1;
            if value > max {
                return Err(format!("value is outside the unsigned {bits}-bit range"));
            }
            Ok((
                value.to_le_bytes()[..width].to_vec(),
                format!("{value} (0x{value:0digits$X})", digits = width * 2),
            ))
        }
        ScalarKind::Float32 | ScalarKind::Float64 => {
            Err(format!("invalid floating-point width: {width}"))
        }
        ScalarKind::Signed | ScalarKind::Unsigned | ScalarKind::Boolean => {
            Err(format!("invalid scalar width: {width}"))
        }
    }
}
fn parse_signed_integer(source: &str) -> Result<i128, String> {
    let source = source.trim();
    if let Some(hex) = source
        .strip_prefix("0x")
        .or_else(|| source.strip_prefix("0X"))
    {
        i128::from_str_radix(hex, 16).map_err(|error| error.to_string())
    } else {
        source.parse::<i128>().map_err(|error| error.to_string())
    }
}
fn parse_unsigned_integer(source: &str) -> Result<u128, String> {
    let source = source.trim();
    if let Some(hex) = source
        .strip_prefix("0x")
        .or_else(|| source.strip_prefix("0X"))
    {
        u128::from_str_radix(hex, 16).map_err(|error| error.to_string())
    } else {
        source.parse::<u128>().map_err(|error| error.to_string())
    }
}
fn collect_expression_names(expression: &Expr, output: &mut Vec<String>) {
    match expression {
        Expr::Variable(name) => output.push(name.clone()),
        Expr::Unary { value, .. } => collect_expression_names(value, output),
        Expr::Binary { left, right, .. } => {
            collect_expression_names(left, output);
            collect_expression_names(right, output);
        }
        Expr::Number(_) => {}
    }
}

fn emit(
    stdout: &Arc<Mutex<DapWriter<io::Stdout>>>,
    event: &str,
    body: Value,
) -> Result<(), String> {
    stdout
        .lock()
        .unwrap()
        .event(event, body)
        .map_err(|error| error.to_string())
}

fn spontaneous_stopped_body(state: &SessionState, spontaneous_stop: bool) -> Option<Value> {
    if !spontaneous_stop {
        return None;
    }
    let reason = match &state.target_state {
        TargetState::Halted { reason } => match reason.as_str() {
            "breakpoint" => "breakpoint",
            "watchpoint" => "data breakpoint",
            "exception" => "exception",
            "step" => "step",
            _ => "pause",
        },
        TargetState::LockedUp => "exception",
        _ => return None,
    };
    Some(json!({
        "reason": reason,
        "threadId": 1,
        "allThreadsStopped": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_config_parses_under_reset_as_an_explicit_opt_in() {
        let normal = parse_probe_config("STM32H723VG", &json!({}));
        assert!(!normal.connect_under_reset);
        assert_eq!(normal.protocol, "swd");
        assert_eq!(normal.speed_khz, 10_000);

        let under_reset = parse_probe_config(
            "STM32H723VG",
            &json!({
                "selector": "STLink V2-1,SN:1234",
                "protocol": "swd",
                "speedKHz": 1_000,
                "connectUnderReset": true
            }),
        );
        assert!(under_reset.connect_under_reset);
        assert_eq!(under_reset.selector.as_deref(), Some("STLink V2-1,SN:1234"));
        assert_eq!(under_reset.speed_khz, 1_000);
    }

    #[test]
    fn plot_only_mode_rejects_writes_and_resets() {
        assert!(require_debug_control(true, "flash").is_err());
        assert!(require_debug_control(true, "memory write").is_err());
        assert!(require_debug_control(false, "flash").is_ok());
    }

    #[test]
    fn live_watch_integer_writes_preserve_full_width_and_validate_ranges() {
        let (bytes, display) =
            encode_scalar_source("0xFEDCBA9876543210", ScalarKind::Unsigned, 8).unwrap();
        assert_eq!(bytes, 0xFEDCBA9876543210_u64.to_le_bytes());
        assert_eq!(display, "18364758544493064720 (0xFEDCBA9876543210)");

        let (bytes, display) = encode_scalar_source("-2", ScalarKind::Signed, 2).unwrap();
        assert_eq!(bytes, [0xFE, 0xFF]);
        assert_eq!(display, "-2 (0xFFFE)");
        assert!(encode_scalar_source("256", ScalarKind::Unsigned, 1).is_err());
        assert!(encode_scalar_source("128", ScalarKind::Signed, 1).is_err());
    }

    #[test]
    fn pointer_member_writes_resolve_the_current_pointee() {
        let worker = spawn_worker(MockBackend::default());
        worker.call(WorkerCommand::Connect(parse_probe_config("Cortex-M Mock", &json!({})))).unwrap();
        let pointer_address = 0x2000_0100;
        let pointee = 0x2000_0200_u32;
        worker.call(WorkerCommand::WriteMemory { address: pointer_address, data: pointee.to_le_bytes().to_vec() }).unwrap();
        let item = VariableDescriptor {
            id: "pointer.value".into(), name: "value".into(), expression: "pointer->value".into(),
            type_name: "float".into(), address: None, pointer_address: Some(pointer_address),
            pointer_offset: Some(4), byte_width: 4, scalar_kind: ScalarKind::Float32,
            writable: true, children: Vec::new(),
        };
        assert_eq!(resolve_descriptor_address(&worker, &item).unwrap(), u64::from(pointee) + 4);
        let written = set_named_value(&worker, std::slice::from_ref(&item), &item.id, "3.5").unwrap();
        assert_eq!(written["numericValue"], 3.5);
        let bytes = match worker.call(WorkerCommand::ReadMemory { address: u64::from(pointee) + 4, length: 4 }).unwrap() {
            WorkerReply::Memory(bytes) => bytes,
            _ => panic!("unexpected read reply"),
        };
        assert_eq!(f32::from_le_bytes(bytes.try_into().unwrap()), 3.5);
        let _ = worker.call_urgent(WorkerCommand::Shutdown);
    }

    #[test]
    fn spontaneous_breakpoint_maps_to_one_standard_stop() {
        let state = SessionState {
            target_state: TargetState::Halted {
                reason: "breakpoint".into(),
            },
            ..Default::default()
        };
        let body = spontaneous_stopped_body(&state, true).unwrap();
        assert_eq!(body["reason"], "breakpoint");
        assert_eq!(body["threadId"], 1);
        assert_eq!(body["allThreadsStopped"], true);
    }

    #[test]
    fn explicit_stop_state_does_not_emit_a_second_standard_stop() {
        let state = SessionState {
            target_state: TargetState::Halted {
                reason: "pause".into(),
            },
            ..Default::default()
        };
        assert!(spontaneous_stopped_body(&state, false).is_none());
    }

    #[test]
    fn spontaneous_watchpoint_and_lockup_use_dap_reasons() {
        let watchpoint = SessionState {
            target_state: TargetState::Halted {
                reason: "watchpoint".into(),
            },
            ..Default::default()
        };
        let locked_up = SessionState {
            target_state: TargetState::LockedUp,
            ..Default::default()
        };
        assert_eq!(
            spontaneous_stopped_body(&watchpoint, true).unwrap()["reason"],
            "data breakpoint"
        );
        assert_eq!(
            spontaneous_stopped_body(&locked_up, true).unwrap()["reason"],
            "exception"
        );
    }
}
