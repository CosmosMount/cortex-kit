import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('Plot time window persists without changing target subscriptions, and cancelling restores the selection', async () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const historySetting = manifest.contributes.configuration.properties['cortexKit.historySeconds'];
  let seconds = 30, writes = 0, requests = 0;
  let input: string | undefined = '75';
  const messages: any[] = [];
  const exports: any = {};
  const vscode = {
    EventEmitter: class { event = () => ({ dispose() {} }); dispose() {} },
    workspace: { workspaceFolders: [{ uri: 'workspace' }], getConfiguration: (_section: string, resource: unknown) => ({
      get: (_key: string, fallback: unknown) => seconds ?? fallback,
      update: async (_key: string, value: number, target: number) => {
        assert.equal(resource, 'workspace');
        assert.equal(target, 3);
        assert.equal(historySetting.scope, 'resource', 'Folder Settings writes require resource scope in the extension manifest');
        seconds = value; writes++;
      },
    }) },
    ConfigurationTarget: { WorkspaceFolder: 3, Global: 1 },
    window: { showInputBox: async () => input },
  };
  runInNewContext(readFileSync(path.join(__dirname, '../plots.js'), 'utf8'), {
    exports, require: (name: string) => name === 'vscode' ? vscode : require(name.startsWith('./') ? '../' + name.slice(2) : name),
  });
  const provider = new exports.PlotViewProvider({ workspaceState: { get: (_key: string, fallback: unknown) => fallback } });
  provider.view = { webview: { postMessage: (message: unknown) => { messages.push(message); } } };
  provider.activeSession = { customRequest: async () => { requests++; } };
  await provider.handleMessage({ type: 'setHistorySeconds', seconds: 120 });
  assert.equal(seconds, 120);
  assert.equal(messages.at(-1).historySeconds, 120);
  await provider.handleMessage({ type: 'setHistorySeconds', seconds: 'custom' });
  assert.equal(seconds, 75);
  input = undefined;
  await provider.handleMessage({ type: 'setHistorySeconds', seconds: 'custom' });
  await provider.handleMessage({ type: 'setHistorySeconds', seconds: 0 });
  await provider.handleMessage({ type: 'setHistorySeconds', seconds: 601 });
  assert.equal(writes, 2);
  assert.equal(messages.at(-1).historySeconds, 75);
  assert.equal(requests, 0);
  assert.ok(messages.every(message => message.type === 'historyWindow'));
});

test('Plot keeps data beyond 30 seconds when extended and trims immediately when shortened', () => {
  let receive: (event: any) => void = () => {};
  const custom = { textContent: '' };
  const nodes = new Map<string, any>();
  const context: any = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: (id: string) => {
      if (!nodes.has(id)) { nodes.set(id, { addEventListener() {}, querySelector: () => custom, value: '' }); }
      return nodes.get(id);
    } },
    window: { addEventListener: (name: string, callback: any) => { if (name === 'message') { receive = callback; } } },
    setTimeout() {},
  };
  const source = readFileSync(path.join(__dirname, '../../../webview-ui/main.js'), 'utf8');
  runInNewContext(source.replace("vscode.postMessage({ type: 'ready' });", 'globalThis.historyForTest = histories;'), context);
  receive({ data: { type: 'historyWindow', historySeconds: 120 } });
  receive({ data: { type: 'samples', batch: { channelIds: ['signal'], sampleCount: 91, startTimestampNs: 0, samplePeriodNs: 1e9, streamEpoch: 1, droppedFrames: 0, values: Array.from({ length: 91 }, (_, i) => i) } } });
  assert.equal(context.historyForTest.get('signal').length, 91);
  receive({ data: { type: 'historyWindow', historySeconds: 10 } });
  assert.equal(context.historyForTest.get('signal').length, 11);
  assert.equal(context.historyForTest.get('signal')[0].t, 80);
  receive({ data: { type: 'historyWindow', historySeconds: 75 } });
  assert.equal(context.historyForTest.get('signal').length, 11, 'extending cannot recreate previously discarded data');
  assert.equal(nodes.get('history-seconds').value, 'custom');
  assert.equal(custom.textContent, '自定义：75 秒');
});
