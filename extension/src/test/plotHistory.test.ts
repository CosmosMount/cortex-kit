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
  provider.dispose();
});

test('Plot webview has no raw-sample history or TypeScript FFT fallback', () => {
  const source = readFileSync(path.join(__dirname, '../../../webview-ui/main.js'), 'utf8');
  assert.doesNotMatch(source, /const histories|data\.type === 'samples'|function fftMagnitudes|function append\(batch\)/);
  assert.match(source, /new NativePlot\(nativeOptions\)/);
});
