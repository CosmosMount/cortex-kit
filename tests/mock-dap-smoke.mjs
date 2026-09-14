import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DapClient } from './dap-client.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap');

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
  await request('cortexKit/setSubscriptions', { ids: ['mock.sine'], requestedSamplesPerSecond: 1000, backgroundIds: ['mock.sine', 'mock.ramp'], backgroundSamplesPerSecond: 20 });
  const frame = new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: dataReady.body.port }, () => socket.write(`${dataReady.body.token}\n`));
    let data = Buffer.alloc(0); const timer = setTimeout(() => { socket.destroy(); reject(new Error('sample frame timeout')); }, 3000);
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); if (data.length >= 8 && data.length >= 4 + data.readUInt32LE(0)) { clearTimeout(timer); socket.destroy(); resolve(data.subarray(4, 8).toString('ascii')); } });
    socket.on('error', reject);
  });
  await request('configurationDone', {});
  t.diagnostic('configuration completed and target resumed');
  assert.equal(await frame, 'CKIT');
  t.diagnostic('sample frame received');
  const updatedSubscription = await request('cortexKit/setSubscriptions', { ids: ['mock.sine'], requestedSamplesPerSecond: 1000 });
  assert.equal(updatedSubscription.body.autoPaused, true);
  assert.equal((await request('cortexKit/getState', {})).body.targetState, 'running');
  const written = await request('cortexKit/writeValue', { id: 'mock.sine', value: '12.5' });
  assert.equal(written.body.value, '12.50000000');
  assert.equal(written.body.numericValue, 12.5);
  assert.equal(written.body.verified, true);
  assert.equal(written.body.autoPaused, true);
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
