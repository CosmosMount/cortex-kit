import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('flash output confirms only matching backend responses and reports failures or interruption', () => {
  let factory: any;
  const exports: any = {};
  runInNewContext(readFileSync(path.join(__dirname, '../flashOutput.js'), 'utf8'), {
    exports,
    require: () => ({ debug: { registerDebugAdapterTrackerFactory: (_type: string, value: any) => { factory = value; } } }),
  });
  const lines: string[] = [];
  exports.registerFlashOutput({ appendLine: (line: string) => lines.push(line), append: (line: string) => lines.push(line), show() {} });
  const tracker = factory.createDebugAdapterTracker({ name: 'Firmware', configuration: { chip: 'Test chip' } });
  tracker.onWillReceiveMessage({ type: 'request', command: 'cortexKit/flash', seq: 1, arguments: { path: 'firmware.elf' } });
  tracker.onDidSendMessage({ type: 'response', request_seq: 2, success: true });
  assert.ok(!lines.some(line => line.includes('completed successfully')));
  tracker.onDidSendMessage({ type: 'response', request_seq: 1, success: false, message: 'Probe disconnected' });
  assert.ok(lines.some(line => line.includes('Flash FAILED') && line.includes('Probe disconnected')));
  tracker.onWillReceiveMessage({ type: 'request', command: 'launch', seq: 3, arguments: { flashing: { enabled: true }, programBinary: 'firmware.elf' } });
  tracker.onDidSendMessage({ type: 'response', request_seq: 3, success: true });
  assert.equal(lines.filter(line => line.includes('completed successfully')).length, 1);
  tracker.onWillReceiveMessage({ type: 'request', command: 'cortexKit/flash', seq: 4, arguments: {} });
  tracker.onExit();
  assert.ok(lines.some(line => line.includes('Flash interrupted')));
});
