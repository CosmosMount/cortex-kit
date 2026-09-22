import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DapClient } from './dap-client.mjs';
import { BatchDecoder } from './sample-batch-decoder.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = process.env.CORTEX_KIT_BACKEND
  ?? path.join(root, 'target', 'debug', process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap');
const { NativeDataClient } = createRequire(import.meta.url)('../extension/out/nativeData.js');

test('mock DAP streams and permits only typed Live Watch writes in plot-only mode', { timeout: 10_000 }, async t => {
  const child = spawn(executable, ['--mock'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const messages = framedMessages(child.stdout);
  let sequence = 1;
  const request = async (command, args = {}) => {
    const seq = sequence++; const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body);
    while (true) { const message = await messages.next(); if (message.value?.type === 'response' && message.value.request_seq === seq) { assert.equal(message.value.success, true, message.value.message); return message.value; } }
  };
  await request('initialize', { adapterID: 'cortex-kit' });
  t.diagnostic('initialized');
  await request('attach', { chip: 'Cortex-M Mock', mockProbe: true, stopOnEntry: false, plotOnly: true, flashing: { enabled: false } });
  t.diagnostic('launched');
  await nextMatching(messages, message => message.type === 'event' && message.event === 'initialized');
  t.diagnostic('DAP initialized event received after launch');
  const catalog = await nextMatching(messages, message => message.type === 'event' && message.event === 'cortexKit.catalog');
  assert.equal(catalog.body.variables[0].children[0].expression, 'signal.sine_37hz');
  t.diagnostic('nested variable catalog received');
  const dataReady = await nextMatching(messages, message => message.type === 'event' && message.event === 'cortexKit.dataChannelReady');
  const statics = await request('variables', { variablesReference: 2 });
  const signal = statics.body.variables.find(item => item.name === 'signal');
  assert.ok(signal.variablesReference >= 4);
  assert.ok(!statics.body.variables.some(item => item.name === 'signal.sine_37hz'));
  const members = await request('variables', { variablesReference: signal.variablesReference });
  const sine = members.body.variables.find(item => item.evaluateName === 'signal.sine_37hz');
  assert.equal(sine.variablesReference, 0);
  assert.equal(sine.memoryReference, '0x20000000');
  const page = await request('variables', { variablesReference: signal.variablesReference, start: 1, count: 1 });
  assert.deepEqual(page.body.variables.map(item => item.evaluateName), [members.body.variables[1].evaluateName]);
  const evaluated = await request('evaluate', { expression: 'signal' });
  assert.equal(evaluated.body.variablesReference, signal.variablesReference);
  t.diagnostic('data channel announced');
  const initialSubscription = await request('cortexKit/setSubscriptions', { ids: ['mock.sine'], requestedSamplesPerSecond: 1000, backgroundIds: ['mock.sine', 'mock.ramp'], backgroundSamplesPerSecond: 20 });
  assert.equal(initialSubscription.body.autoPaused, false);
  const changingSamples = new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: dataReady.body.port }, () => socket.write(`${dataReady.body.token}\n`));
    const decoder = new BatchDecoder(); const values = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('changing mock.ramp samples timed out')); }, 3000);
    socket.on('data', chunk => {
      try {
        for (const batch of decoder.push(chunk)) {
          const channel = batch.channelIds.indexOf('mock.ramp');
          if (channel < 0) continue;
          for (let sample = 0; sample < batch.sampleCount; sample += 1) values.push(batch.values[sample * batch.channelIds.length + channel]);
          if (values.length >= 3 && new Set(values.map(value => value.toFixed(6))).size >= 2) {
            clearTimeout(timer); socket.destroy(); resolve(values);
          }
        }
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
    socket.on('error', reject);
  });
  await request('configurationDone', {});
  t.diagnostic('configuration completed and target resumed');
  const rampSamples = await changingSamples;
  assert.ok(rampSamples.at(-1) > rampSamples[0], 'mock.ramp did not change across streamed samples');
  t.diagnostic(`changing mock.ramp samples received: ${rampSamples.map(value => value.toFixed(3)).join(', ')}`);
  const updatedSubscription = await request('cortexKit/setSubscriptions', { ids: ['mock.sine'], requestedSamplesPerSecond: 1000 });
  assert.equal(updatedSubscription.body.autoPaused, false);
  assert.equal((await request('cortexKit/getState', {})).body.targetState, 'running');
  const written = await request('cortexKit/writeValue', { id: 'mock.sine', value: '12.5' });
  assert.equal(written.body.value, '12.50000000');
  assert.equal(written.body.numericValue, 12.5);
  assert.equal(written.body.verified, true);
  assert.equal(written.body.autoPaused, false);
  assert.equal((await request('cortexKit/getState', {})).body.targetState, 'running');
  const writtenBytes = await request('readMemory', { memoryReference: '0x20000000', count: 4 });
  assert.equal(Buffer.from(writtenBytes.body.data, 'base64').readFloatLE(0), 12.5);
  await assert.rejects(request('writeMemory', { memoryReference: '0x20000000', data: 'AAAAAA==' }), /plot-only/);
  await request('pause', { threadId: 1 });
  const stack = await request('stackTrace', { threadId: 1, levels: 1 });
  assert.match(stack.body.stackFrames[0].instructionPointerReference, /^0x[0-9a-f]+$/i);
  const refreshed = await request('cortexKit/readValues', { ids: ['mock.sine'] });
  assert.equal(refreshed.body.values.length, 1);
  const refreshedAfterWrite = await request('cortexKit/readValues', { ids: ['mock.sine'] });
  assert.equal(refreshedAfterWrite.body.values[0].value, 12.5);
  const registers = await request('cortexKit/readRegisters', { registers: [{ id: 'mock-register', address: '0x20000010', sizeBits: 32 }] });
  assert.equal(registers.body.values.length, 1);
  await request('disconnect', {});
});

test('launch runs to main only after configuration and waits for user continue', { timeout: 10_000 }, async t => {
  const child = spawn(executable, ['--mock'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const dap = new DapClient(child);
  await dap.request('initialize', { adapterID: 'cortex-kit' });
  await dap.request('launch', { chip: 'Cortex-M Mock', mockProbe: true, stopOnEntry: true, runToEntryPoint: 'main', flashing: { enabled: false } });
  await dap.waitForEvent(message => message.event === 'initialized');
  assert.equal(dap.events.some(message => message.event === 'stopped'), false, 'adapter stopped before configurationDone');
  await dap.request('configurationDone');
  const stopped = await dap.waitForEvent(message => message.event === 'stopped');
  assert.equal(stopped.body.reason, 'entry');
  assert.deepEqual((await dap.request('cortexKit/getState')).targetState, { halted: { reason: 'entry' } });
  await dap.request('continue', { threadId: 1 });
  assert.equal((await dap.request('cortexKit/getState')).targetState, 'running');
  await dap.request('disconnect');
});

test('Rust latest-value core delivers changing generic Live Watch values', { timeout: 10_000 }, async t => {
  const child = spawn(executable, ['--mock'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const native = await NativeDataClient.launch(executable);
  t.after(async () => { await native.close(); child.kill(); });
  const dap = new DapClient(child);
  await dap.request('initialize', { adapterID: 'cortex-kit' });
  await dap.request('attach', { chip: 'Cortex-M Mock', mockProbe: true, stopOnEntry: false, plotOnly: true, flashing: { enabled: false } });
  await dap.waitForEvent(message => message.event === 'initialized');
  const catalog = await dap.waitForEvent(message => message.event === 'cortexKit.catalog');
  const dataReady = await dap.waitForEvent(message => message.event === 'cortexKit.dataChannelReady');
  await native.configure({
    revision: 1, historySeconds: 2, charts: [],
    catalog: [{ id: 'mock.ramp', name: 'control.ramp', expression: 'control.ramp' }], rawIds: ['mock.ramp'],
  });
  await native.connect({ ...dataReady.body, generation: 1 });
  await native.latest(['mock.ramp'], 0); // Registers the latest-value interest before sampling starts.
  await dap.request('cortexKit/setSubscriptions', { ids: ['mock.ramp'], requestedSamplesPerSecond: 1000 });
  await dap.request('configurationDone');

  let revision = 0;
  const observed = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && observed.length < 3) {
    const latest = await native.latest(['mock.ramp'], revision);
    revision = latest.revision;
    if (latest.values.length) observed.push(latest.values[0]);
    if (observed.length < 3) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(catalog.body.variables.some(variable => variable.id === 'mock.ramp'), true);
  assert.ok(observed.length >= 3, `expected at least 3 Rust latest snapshots, got ${observed.length}`);
  assert.ok(new Set(observed.map(item => item.value?.toFixed(6))).size >= 2, 'Rust latest snapshots repeated one frozen value');
  for (let index = 1; index < observed.length; index += 1) {
    assert.ok(BigInt(observed[index].timestampNsExact) > BigInt(observed[index - 1].timestampNsExact), 'Rust latest timestamp did not advance');
  }
  await dap.request('disconnect');
});

test('native variable writes resolve children within the expanded parent', { timeout: 10_000 }, async t => {
  const child = spawn(executable, ['--mock'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const dap = new DapClient(child);
  await dap.request('initialize', { adapterID: 'cortex-kit' });
  await dap.request('attach', { chip: 'Cortex-M Mock', mockProbe: true, stopOnEntry: true, flashing: { enabled: false } });
  const statics = await dap.request('variables', { variablesReference: 2 });
  const signal = statics.variables.find(item => item.name === 'signal');
  await dap.request('setVariable', { variablesReference: signal.variablesReference, name: 'sine_37hz', value: '7.25' });
  const members = await dap.request('variables', { variablesReference: signal.variablesReference });
  assert.equal(Number(members.variables.find(item => item.name === 'sine_37hz').value), 7.25);
  await assert.rejects(dap.request('setVariable', { variablesReference: 2, name: 'sine_37hz', value: '8' }), /unknown child variable/);
  await dap.request('disconnect');
});

async function nextMatching(iterator, predicate) { while (true) { const next = await iterator.next(); if (next.done) throw new Error('DAP stream ended'); if (predicate(next.value)) return next.value; } }

async function* framedMessages(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const headerEnd = pending.indexOf('\r\n\r\n'); if (headerEnd < 0) break;
      const header = pending.subarray(0, headerEnd).toString('ascii'); const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(length) || pending.length < headerEnd + 4 + length) break;
      const start = headerEnd + 4; yield JSON.parse(pending.subarray(start, start + length).toString('utf8')); pending = pending.subarray(start + length);
    }
  }
}
