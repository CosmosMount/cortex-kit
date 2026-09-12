import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { BatchDecoder } = require(path.join(root, 'extension', 'out', 'binaryProtocol.js'));
const [
  programBinary,
  selector = 'auto',
  secondsText = '2',
  speedText = '1000',
  connectUnderResetText = 'true',
  flashText = 'false',
  validatePauseText = 'true',
  requestedSamplesPerSecondText = '1000',
  channelProfile = 'representative',
  channelCountText = '8',
  sourceBreakpointText,
  benchmarkSecondsText = '0',
  backendProfile = 'debug',
  plotOnlyText = 'false',
  verifyRunningWriteText = 'false',
] = process.argv.slice(2);

if (!programBinary) {
  console.error('Usage: node tests/hardware-dap-smoke.mjs <firmware.elf> [probe-selector] [seconds] [speed-khz] [connect-under-reset] [flash] [validate-pause] [requested-sps] [representative|contiguous] [channel-count] [source-file:line] [benchmark-seconds] [debug|release] [plot-only] [verify-running-write]');
  process.exit(2);
}

if (!['debug', 'release'].includes(backendProfile)) {
  console.error(`backend profile must be debug or release, got ${backendProfile}`);
  process.exit(2);
}
const executable = process.env.CORTEX_KIT_BACKEND ?? path.join(root, 'target', backendProfile, process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap');

async function main() {
  const seconds = parsePositiveNumber(secondsText, 'seconds', 0.25);
  const speedKHz = parsePositiveNumber(speedText, 'speed-khz', 1);
  const connectUnderReset = parseBoolean(connectUnderResetText, 'connect-under-reset');
  const flash = parseBoolean(flashText, 'flash');
  const validatePause = parseBoolean(validatePauseText, 'validate-pause');
  const requestedSamplesPerSecond = parsePositiveInteger(requestedSamplesPerSecondText, 'requested-sps');
  const channelCount = parsePositiveInteger(channelCountText, 'channel-count');
  const sourceBreakpoint = parseSourceBreakpoint(sourceBreakpointText);
  const benchmarkSeconds = parseNonNegativeNumber(benchmarkSecondsText, 'benchmark-seconds');
  const plotOnly = parseBoolean(plotOnlyText, 'plot-only');
  const verifyRunningWrite = parseBoolean(verifyRunningWriteText, 'verify-running-write');
  if (plotOnly && (flash || validatePause || sourceBreakpoint)) {
    throw new Error('plot-only requires flash=false, validate-pause=false, and no source breakpoint');
  }
  if (!['representative', 'contiguous'].includes(channelProfile)) {
    throw new Error(`channel profile must be representative or contiguous, got ${channelProfile}`);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const dap = new DapClient(child);
  let protocolReady = false;
  let targetPaused = false;
  let breakpointCleanupNeeded = false;
  let breakpointMayHaveHalted = false;
  let result;
  let failure;
  const cleanupErrors = [];

  try {
  await dap.request('initialize', { adapterID: 'cortex-kit' });
  protocolReady = true;
  await dap.request(flash ? 'launch' : 'attach', {
    chip: 'STM32H723VG',
    programBinary,
    stopOnEntry: false,
    plotOnly,
    probe: { selector, protocol: 'swd', speedKHz, connectUnderReset },
    flashing: { enabled: flash, verify: true, resetAfter: true },
    acquisition: { requestedSamplesPerSecond },
  }, flash ? 180_000 : 60_000);

  const catalogEvent = await dap.waitForEvent(
    message => message.event === 'cortexKit.catalog',
    60_000,
    'variable catalog',
  );
  const dataReady = await dap.waitForEvent(
    message => message.event === 'cortexKit.dataChannelReady',
    10_000,
    'data channel announcement',
  );
  const leaves = flatten(catalogEvent.body.variables)
    .filter(item => item.address !== undefined && !item.children.length && [1, 2, 4, 8].includes(item.byteWidth));
  const representative = [
    'SysTime.ms',
    'SysTime.us',
    'pendulum_debug.thread_time',
    'pendulum_debug.pitch',
    'pendulum_debug.yaw',
    'debug_ins.accel[0]',
    'debug_ins.accel[1]',
    'debug_temp',
    'CNT_TEMP1',
  ];
  const contiguous = [
    'pendulum_debug.alphal_eq',
    'pendulum_debug.alphar_eq',
    'pendulum_debug.alphal',
    'pendulum_debug.alphal_dot',
    'pendulum_debug.alphar',
    'pendulum_debug.alphar_dot',
    'pendulum_debug.x',
    'pendulum_debug.xref',
  ];
  const preferred = channelProfile === 'contiguous' ? contiguous : representative;
  const selected = preferred
    .map(name => leaves.find(item => item.expression === name || item.name === name))
    .filter(Boolean)
    .slice(0, channelCount);
  if (!selected.length) {
    selected.push(...leaves.filter(item => item.address >= 0x20000000 && item.address < 0x40000000).slice(0, 4));
  }
  assert.ok(selected.length, 'ELF contains no addressable scalar variables');

  const customSelection = process.env.CORTEX_KIT_SELECTION
    ? JSON.parse(readFileSync(process.env.CORTEX_KIT_SELECTION, 'utf8')) : undefined;
  if (customSelection) {
    const ids = [...new Set([...customSelection.ids, ...(customSelection.backgroundIds ?? [])])];
    selected.splice(0, selected.length, ...ids.map(id => {
      const variable = leaves.find(item => item.id === id);
      assert.ok(variable, `selection is missing from current ELF: ${id}`);
      return variable;
    }));
  }
  const subscriptionUpdate = await dap.request('cortexKit/setSubscriptions', {
    ids: selected.map(item => item.id),
    requestedSamplesPerSecond,
    ...customSelection,
  });
  await dap.request('configurationDone', {});
  const collection = await collectBatches(dataReady.body, seconds);
  const { batches } = collection;
  assert.ok(batches.length, 'no sample batches received');
  const acquisitionState = await dap.request('cortexKit/getState');
  assert.ok(!acquisitionState.lastError, acquisitionState.lastError);
  let recordingCsv;
  if (process.env.CORTEX_KIT_CSV) {
    const { FrameSampler, csvHeader, csvRows, parseCsv } = require(path.join(root, 'extension', 'out', 'recordingModel.js'));
    const recorded = customSelection ? selected.filter(item => customSelection.ids.includes(item.id)) : selected;
    const sampler = new FrameSampler(recorded.map(item => item.id), Number(process.env.CORTEX_KIT_CSV_RATE ?? requestedSamplesPerSecond));
    const rows = batches.flatMap(batch => sampler.accept(batch));
    assert.ok(rows.length > 1, 'CSV recording received too few samples');
    const csv = csvHeader(recorded.map(item => item.expression)) + csvRows(rows);
    writeFileSync(process.env.CORTEX_KIT_CSV, csv, 'utf8');
    const imported = parseCsv(readFileSync(process.env.CORTEX_KIT_CSV, 'utf8'));
    assert.equal(imported.rows.length, rows.length);
    assert.equal(imported.headers.length, recorded.length + 3);
    recordingCsv = { path: process.env.CORTEX_KIT_CSV, rows: rows.length, requestedSamplesPerSecond: sampler.requestedHz, actualSamplesPerSecond: sampler.actualHz, elapsedSeconds: sampler.elapsedSeconds, roundTripVerified: true };
  }

  let runningWrite = { enabled: false };
  if (verifyRunningWrite) {
    const candidate = leaves.find(item => item.expression === 'AliveThread.tx_thread_id')
      ?? leaves.find(item => item.writable && item.byteWidth <= 4 && item.typeName !== 'pointer');
    assert.ok(candidate, 'ELF contains no safe scalar candidate for same-value write verification');
    const stateBefore = await dap.request('cortexKit/getState');
    assert.ok(stateBefore.targetState === 'running' || stateBefore.targetState === 'sleeping', 'target was not running before Live Watch write');
    const before = await dap.request('cortexKit/readValues', { ids: [candidate.id] });
    assert.equal(before.values?.length, 1, 'could not read Live Watch write candidate');
    const writeStarted = performance.now();
    const written = await dap.request('cortexKit/writeValue', { id: candidate.id, value: String(before.values[0].value) });
    const writeResponseMs = performance.now() - writeStarted;
    const after = await dap.request('cortexKit/readValues', { ids: [candidate.id] });
    const stateAfter = await dap.request('cortexKit/getState');
    assert.equal(written.verified, true, `running write did not verify; readback was ${written.value}`);
    assert.equal(written.autoPaused, true, 'running Live Watch write was not automatically paused');
    assert.equal(after.values?.length, 1, 'could not read the value after running-state write');
    assert.ok(stateAfter.targetState === 'running' || stateAfter.targetState === 'sleeping', 'Live Watch write changed target execution state');
    runningWrite = {
      enabled: true,
      expression: candidate.expression,
      address: `0x${candidate.address.toString(16)}`,
      before: before.values[0].value,
      adapterReadback: written.numericValue,
      after: after.values[0].value,
      verified: written.verified,
      autoPaused: written.autoPaused,
      writeResponseMs: roundMilliseconds(writeResponseMs),
      targetStateAfter: stateAfter.targetState,
    };
  }

  let plotProtection = { enabled: false };
  if (plotOnly) {
    const breakpointBody = await dap.request('setInstructionBreakpoints', {
      breakpoints: [{ instructionReference: '0x08000000' }],
    });
    assert.equal(breakpointBody.breakpoints?.[0]?.verified, false, 'plot-only accepted a hardware breakpoint');
    const pauseStarted = performance.now();
    await dap.request('pause', { threadId: 1 });
    targetPaused = true;
    await dap.waitForEvent(message => message.event === 'stopped' && message.body?.reason === 'pause', 3_000, 'plot-only pause event');
    const pauseResponseMs = performance.now() - pauseStarted;
    await dap.request('continue', { threadId: 1 });
    targetPaused = false;
    await dap.waitForEvent(message => message.event === 'continued', 3_000, 'plot-only continue event');
    await assert.rejects(dap.request('writeMemory', { memoryReference: '0x20000000', data: 'AAAAAA==' }), /plot-only/);
    await assert.rejects(dap.request('cortexKit/writeValue', { id: '__missing_live_watch_variable__', value: '0' }), /unknown variable/);
    plotProtection = { enabled: true, breakpointBlocked: true, pauseAllowed: true, continueAllowed: true, pauseResponseMs: roundMilliseconds(pauseResponseMs), memoryWriteBlocked: true, typedLiveWatchWriteAvailable: true };
  }

  let acquisitionBenchmark = { enabled: false };
  if (benchmarkSeconds > 0) {
    const benchmark = await dap.request(
      'cortexKit/benchmark',
      { seconds: benchmarkSeconds },
      Math.max(15_000, (Math.min(10, Math.max(0.1, benchmarkSeconds)) + 5) * 1000),
    );
    acquisitionBenchmark = {
      enabled: true,
      requestedDurationSeconds: benchmarkSeconds,
      requestedSamplesPerSecond: benchmark.requestedSamplesPerSecond,
      actualSamplesPerSecond: benchmark.actualSamplesPerSecond,
      meanIntervalMicros: benchmark.meanIntervalMicros,
      p95IntervalMicros: benchmark.p95IntervalMicros,
      p99IntervalMicros: benchmark.p99IntervalMicros,
      readErrors: benchmark.readErrors,
    };
  }

  let sourceBreakpointResult = { enabled: false };
  if (sourceBreakpoint) {
    const breakpointStarted = performance.now();
    breakpointCleanupNeeded = true;
    breakpointMayHaveHalted = true;
    const breakpointBody = await dap.request('setBreakpoints', {
      source: { path: sourceBreakpoint.sourcePath },
      breakpoints: [{ line: sourceBreakpoint.line }],
    }, 10_000);
    const resolved = breakpointBody.breakpoints?.[0];
    assert.ok(resolved, 'setBreakpoints returned no breakpoint');
    assert.equal(resolved.verified, true, resolved.message ?? 'source breakpoint was not verified');
    const stopped = await dap.waitForEvent(
      message => message.event === 'stopped' && message.body?.reason === 'breakpoint',
      5_000,
      `source breakpoint hit at ${resolved.instructionReference ?? '<unknown>'} (resolved line ${resolved.line ?? '<unknown>'})`,
    );
    targetPaused = true;
    const hitLatencyMs = performance.now() - breakpointStarted;
    const hitAddress = stopped.body?.instructionReference ?? resolved.instructionReference;
    assert.ok(hitAddress, 'verified source breakpoint has no resolved instruction address');

    const stoppedStack = await dap.request('stackTrace', { threadId: 1, startFrame: 0, levels: 1 }, 10_000);
    const topFrame = stoppedStack.stackFrames?.[0];
    assert.ok(topFrame?.source?.path, 'stopped stack frame did not resolve a DWARF source path');
    assert.ok(topFrame.line > 0, 'stopped stack frame did not resolve a source line');
    const refreshedVariables = await dap.request('cortexKit/readValues', { ids: [selected[0].id] }, 10_000);
    assert.equal(refreshedVariables.values?.length, 1, 'halted variable refresh did not return the selected value');
    const refreshedRegisters = await dap.request('cortexKit/readRegisters', { registers: [{ id: 'DBGMCU_IDC', address: '0x5c001000', sizeBits: 32 }] }, 10_000);
    assert.equal(refreshedRegisters.values?.length, 1, 'halted peripheral refresh did not return DBGMCU_IDC');

    await dap.request('setBreakpoints', {
      source: { path: sourceBreakpoint.sourcePath },
      breakpoints: [],
    }, 10_000);
    breakpointCleanupNeeded = false;
    const resumeStarted = performance.now();
    await dap.request('continue', { threadId: 1 }, 10_000);
    targetPaused = false;
    breakpointMayHaveHalted = false;
    const resumeResponseMs = performance.now() - resumeStarted;
    await dap.waitForEvent(
      message => message.event === 'continued',
      3_000,
      'continued event after source breakpoint',
    );
    sourceBreakpointResult = {
      enabled: true,
      sourcePath: sourceBreakpoint.sourcePath,
      requestedLine: sourceBreakpoint.line,
      resolvedLine: resolved.line,
      address: hitAddress,
      stoppedFrame: { name: topFrame.name, source: topFrame.source.path, line: topFrame.line, instructionPointerReference: topFrame.instructionPointerReference },
      refreshedVariable: { expression: selected[0].expression, value: refreshedVariables.values[0].value },
      refreshedRegister: { name: 'DBGMCU_IDC', value: `0x${Math.trunc(refreshedRegisters.values[0].value).toString(16).padStart(8, '0')}` },
      hitLatencyMs: roundMilliseconds(hitLatencyMs),
      resumeResponseMs: roundMilliseconds(resumeResponseMs),
    };
  }

  let debugControl = { enabled: false };
  if (validatePause) {
    const pauseStarted = performance.now();
    await dap.request('pause', { threadId: 1 }, 10_000);
    targetPaused = true;
    const pauseResponseMs = performance.now() - pauseStarted;
    await dap.waitForEvent(
      message => message.event === 'stopped' && message.body?.reason === 'pause',
      3_000,
      'pause stopped event',
    );
    const pauseStoppedEventMs = performance.now() - pauseStarted;

    const scopeBody = await dap.request('scopes', { frameId: 1 }, 10_000);
    const registerScope = scopeBody.scopes?.find(scope => /register/i.test(scope.name));
    assert.ok(registerScope?.variablesReference, 'DAP did not expose a CPU Registers scope');
    const registerBody = await dap.request('variables', {
      variablesReference: registerScope.variablesReference,
    }, 10_000);
    const registers = registerBody.variables ?? [];
    assert.ok(registers.length, 'CPU Registers scope was empty');
    const pc = registers.find(register => /(^|[^a-z0-9])(pc|r15)([^a-z0-9]|$)/i.test(register.name));
    assert.ok(pc, 'CPU Registers scope did not contain PC/R15');
    assert.notEqual(pc.value, '<unavailable>', 'PC/R15 was unavailable');

    const peripheralRead = await dap.request('readMemory', {
      memoryReference: '0x5c001000',
      count: 4,
    }, 10_000);
    const peripheralBytes = Buffer.from(peripheralRead.data ?? '', 'base64');
    assert.equal(peripheralBytes.length, 4, 'DBGMCU_IDC read did not return four bytes');
    const dbgMcuIdc = peripheralBytes.readUInt32LE(0);
    assert.notEqual(dbgMcuIdc, 0, 'DBGMCU_IDC unexpectedly read as zero');

    const resumeStarted = performance.now();
    await dap.request('continue', { threadId: 1 }, 10_000);
    targetPaused = false;
    const resumeResponseMs = performance.now() - resumeStarted;
    await dap.waitForEvent(
      message => message.event === 'continued',
      3_000,
      'continued event',
    );
    debugControl = {
      enabled: true,
      pauseResponseMs: roundMilliseconds(pauseResponseMs),
      pauseStoppedEventMs: roundMilliseconds(pauseStoppedEventMs),
      resumeResponseMs: roundMilliseconds(resumeResponseMs),
      registerCount: registers.length,
      pc: { name: pc.name, value: pc.value },
      peripheralRegister: { name: 'DBGMCU_IDC', address: '0x5c001000', value: `0x${dbgMcuIdc.toString(16).padStart(8, '0')}` },
      selectedRegisters: registers
        .filter(register => /^(pc|r15|sp|r13|lr|r14|xpsr)$/i.test(register.name))
        .map(register => ({ name: register.name, value: register.value })),
    };
  }

  result = {
    probe: selector,
    chip: 'STM32H723VG',
    speedKHz,
    backendProfile,
    executable,
    selection: customSelection,
    acquisitionState,
    recordingCsv,
    requestedSamplesPerSecond,
    channelProfile,
    channelCount: selected.length,
    connectUnderReset,
    durationSeconds: seconds,
    flashed: flash,
    plotOnly,
    rootVariables: catalogEvent.body.variables.length,
    scalarLeaves: leaves.length,
    batches: batches.length,
    acquisitionBenchmark,
    sourceBreakpoint: sourceBreakpointResult,
    debugControl,
    plotProtection,
    subscriptionUpdate,
    runningWrite,
    ...summarize(batches, selected, collection.elapsedSeconds),
  };
  } catch (error) {
    failure = error;
  } finally {
    if (protocolReady && breakpointCleanupNeeded && sourceBreakpoint) {
      try {
        await dap.request('setBreakpoints', {
          source: { path: sourceBreakpoint.sourcePath },
          breakpoints: [],
        }, 5_000);
        breakpointCleanupNeeded = false;
      } catch (error) {
        cleanupErrors.push(new Error(`could not remove the source breakpoint before disconnect: ${describeError(error)}`));
      }
    }
    if (protocolReady && (targetPaused || breakpointMayHaveHalted)) {
      try {
        await dap.request('continue', { threadId: 1 }, 5_000);
        targetPaused = false;
        breakpointMayHaveHalted = false;
      } catch (error) {
        cleanupErrors.push(new Error(`could not resume the target before disconnect: ${describeError(error)}`));
      }
    }
    if (protocolReady) {
      try {
        await dap.request('disconnect', {}, 10_000);
      } catch (error) {
        cleanupErrors.push(new Error(`clean DAP disconnect failed: ${describeError(error)}`));
      }
    }

    if (!(await waitForExit(child, 1_000)) && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(child, 1_000);
    }
  }

  if (failure || cleanupErrors.length) {
    if (failure) console.error(describeError(failure));
    for (const error of cleanupErrors) console.error(describeError(error));
    if (stderr.trim()) console.error(stderr.trim());
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

class DapClient {
  constructor(childProcess) {
    this.child = childProcess;
    this.sequence = 1;
    this.pending = new Map();
    this.events = [];
    this.eventWaiters = [];
    this.input = Buffer.alloc(0);
    this.closedError = undefined;

    childProcess.stdout.on('data', chunk => this.accept(chunk));
    childProcess.stdout.on('error', error => this.close(new Error(`DAP stdout failed: ${describeError(error)}`)));
    childProcess.stdout.on('end', () => this.close(new Error('DAP stdout ended')));
    // A failed request can close the adapter while a write is still buffered. Keeping
    // this listener installed prevents the resulting EPIPE/ECONNRESET from escaping.
    childProcess.stdin.on('error', error => this.close(new Error(`DAP stdin failed: ${describeError(error)}`)));
    childProcess.on('error', error => this.close(new Error(`DAP process failed: ${describeError(error)}`)));
    childProcess.on('exit', (code, signal) => {
      this.close(new Error(`DAP exited (${signal ? `signal ${signal}` : `code ${code}`})`));
    });
  }

  request(command, args = {}, timeoutMs = 30_000) {
    if (this.closedError) return Promise.reject(this.closedError);
    const seq = this.sequence++;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    const frame = Buffer.concat([header, body]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(seq)) return;
        reject(new Error(`${command}: DAP response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
      try {
        this.child.stdin.write(frame, error => {
          if (error) this.rejectPending(seq, new Error(`${command}: DAP write failed: ${describeError(error)}`));
        });
      } catch (error) {
        this.rejectPending(seq, new Error(`${command}: DAP write failed: ${describeError(error)}`));
      }
    });
  }

  waitForEvent(predicate, timeoutMs = 10_000, description = 'DAP event') {
    const queuedIndex = this.events.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.events.splice(queuedIndex, 1)[0]);
    if (this.closedError) return Promise.reject(this.closedError);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        reject(new Error(`${description} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  accept(chunk) {
    if (this.closedError) return;
    this.input = Buffer.concat([this.input, chunk]);
    try {
      while (true) {
        const headerEnd = this.input.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.input.subarray(0, headerEnd).toString('ascii');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error(`DAP frame has no Content-Length header: ${header}`);
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (this.input.length < start + length) return;
        const message = JSON.parse(this.input.subarray(start, start + length).toString('utf8'));
        this.input = this.input.subarray(start + length);
        this.dispatch(message);
      }
    } catch (error) {
      this.close(new Error(`invalid DAP stream: ${describeError(error)}`));
    }
  }

  dispatch(message) {
    if (message?.type === 'response') {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body ?? {});
      else pending.reject(new Error(`${pending.command}: ${message.message ?? 'request failed'}`));
      return;
    }
    if (message?.type !== 'event') return;
    const waiterIndex = this.eventWaiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.eventWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.events.push(message);
      if (this.events.length > 100) this.events.shift();
    }
  }

  rejectPending(seq, error) {
    const pending = this.pending.get(seq);
    if (!pending) return;
    this.pending.delete(seq);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const [seq] of this.pending) this.rejectPending(seq, error);
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function collectBatches(info, durationSeconds) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(info?.port) || !info?.token) {
      reject(new Error('data channel announcement is missing a valid port or token'));
      return;
    }

    const batches = [];
    const decoder = new BatchDecoder();
    let settled = false;
    const startedAt = performance.now();
    const socket = net.createConnection({ host: '127.0.0.1', port: info.port });
    const timer = setTimeout(() => {
      finish(batches.length ? undefined : new Error('sample frame timeout'));
    }, durationSeconds * 1000);

    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve({ batches, elapsedSeconds: Math.max((performance.now() - startedAt) / 1000, Number.EPSILON) });
    };

    socket.on('connect', () => {
      socket.setNoDelay(true);
      socket.write(`${info.token}\n`, error => {
        if (error) finish(new Error(`data channel authentication failed: ${describeError(error)}`));
      });
    });
    socket.on('data', chunk => {
      try {
        batches.push(...decoder.push(chunk));
      } catch (error) {
        finish(new Error(`invalid sample batch: ${describeError(error)}`));
      }
    });
    // Leave this handler installed after settlement: Windows may report ECONNRESET
    // just after destroy() while the server is still completing its final write.
    socket.on('error', error => finish(new Error(`data channel failed: ${describeError(error)}`)));
    socket.on('close', () => {
      if (!settled) finish(new Error('data channel closed before the sampling interval completed'));
    });
  });
}

function summarize(batches, selected, elapsedSeconds) {
  const series = new Map(selected.map(item => [item.id, []]));
  for (const batch of batches) {
    for (let sample = 0; sample < batch.sampleCount; sample += 1) {
      batch.channelIds.forEach((id, channel) => {
        series.get(id)?.push(batch.values[sample * batch.channelIds.length + channel]);
      });
    }
  }
  const reportedBatchSamplesPerSecond = batches.at(-1).samplePeriodNs
    ? 1e9 / batches.at(-1).samplePeriodNs
    : 0;
  return {
    actualCollectionSeconds: Math.round(elapsedSeconds * 1000) / 1000,
    reportedBatchSamplePeriodNs: batches.at(-1).samplePeriodNs,
    reportedBatchSamplesPerSecond,
    droppedFrames: batches.at(-1).droppedFrames,
    variables: selected.map(item => {
      const values = series.get(item.id) ?? [];
      const { min, max } = range(values);
      return {
        expression: item.expression,
        type: item.typeName,
        address: `0x${item.address.toString(16)}`,
        samples: values.length,
        observedSamplesPerSecond: Math.round((values.length / elapsedSeconds) * 100) / 100,
        first: values[0],
        last: values.at(-1),
        min,
        max,
      };
    }),
  };
}

function range(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return values.length ? { min, max } : { min: undefined, max: undefined };
}

function flatten(items) {
  return items.flatMap(item => [item, ...flatten(item.children ?? [])]);
}

function parseBoolean(value, label) {
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${label} must be true or false, got ${value}`);
}

function parsePositiveNumber(value, label, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    throw new Error(`${label} must be a number greater than or equal to ${minimum}, got ${value}`);
  }
  return number;
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return number;
}

function parseNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number, got ${value}`);
  }
  return number;
}

function parseSourceBreakpoint(value) {
  if (value === undefined || value.trim() === '') return undefined;
  // The path part is greedy so a Windows drive colon remains part of the path;
  // only the final :digits suffix is interpreted as the source line.
  const match = /^(.+):(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`source breakpoint must use source-file:line, got ${value}`);
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`source breakpoint line must be a positive integer, got ${match[2]}`);
  }
  return { sourcePath: match[1], line };
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      childProcess.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    childProcess.once('exit', onExit);
  });
}

try {
  await main();
} catch (error) {
  console.error(describeError(error));
  process.exitCode = 1;
}
