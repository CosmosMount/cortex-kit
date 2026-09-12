import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseCsv } from '../recordingModel';

test('recorder writes real CSV, restores Plot/Watch subscriptions and imports its output', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-recorder-'));
  const filename = path.join(directory, 'capture.csv');
  const messages: any[] = [], requests: any[] = [];
  let launchConfig: any;
  let closeDuringSave = false;
  class Emitter {
    private listeners: any[] = [];
    event = (callback: any) => { this.listeners.push(callback); return { dispose: () => { this.listeners = this.listeners.filter(item => item !== callback); } }; };
    fire(value: any) { for (const callback of this.listeners) { callback(value); } }
    dispose() { this.listeners = []; }
  }
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const storage = new Map();
  let onDispose = () => {}, disposed = false;
  const vscode = {
    EventEmitter: Emitter, ViewColumn: { Beside: 2 },
    Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
      workspaceFolders: [{ uri: uri(directory) }], getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'configurations' ? [{ name: 'Firmware', type: 'cortex-kit', request: 'launch', preLaunchTask: 'build', postDebugTask: 'cleanup', flashing: { enabled: true } }] : fallback }),
      fs: { stat: async (value: any) => fs.promises.stat(value.fsPath), readFile: async (value: any) => fs.promises.readFile(value.fsPath) },
    },
    window: {
      showQuickPick: async (items: any[]) => items,
      showSaveDialog: async () => { if (closeDuringSave) { recorder.panel.dispose(); } return uri(filename); }, showOpenDialog: async () => [uri(filename)],
      createWebviewPanel: () => ({
        webview: { cspSource: 'test', asWebviewUri: (value: any) => value.fsPath, postMessage: (value: any) => { messages.push(value); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() {} }), html: '' },
        onDidDispose: (callback: () => void) => { onDispose = callback; }, onDidChangeVisibility() {}, visible: true, dispose() { if (!disposed) { disposed = true; onDispose(); } },
      }),
    },
    commands: { executeCommand: async (command: string) => { requests.push({ command }); } },
    debug: { startDebugging: async (_folder: any, config: any) => {
      launchConfig = config;
      plots.setSession({ id: 'auto-attach', configuration: config, workspaceFolder: { uri: uri(directory) }, customRequest: async (_name: string, args: any) => { requests.push(args); } });
      return true;
    } },
  };
  const modules = require('node:module');
  const original = modules._load;
  modules._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  const { PlotViewProvider } = require('../plots');
  const { SampleRecorder } = require('../recorder');
  modules._load = original;
  const context = { extensionUri: uri(directory), workspaceState: { get: (key: string, fallback: any) => storage.get(key) ?? fallback, update: async (key: string, value: any) => { storage.set(key, value); } } };
  const plots = new PlotViewProvider(context);
  const recorder = new SampleRecorder(context, plots);
  try {
    const variables = ['a', 'b', 'watch'].map((id, i) => ({ id, name: id, expression: id, typeName: 'float', address: 0x20000000 + i * 4, byteWidth: 4, scalarKind: 'float32', writable: true, children: [] }));
    plots.setSession({ id: 'debug-session', configuration: {}, workspaceFolder: { uri: uri(directory) }, customRequest: async (_name: string, args: any) => { requests.push(args); } });
    plots.setCatalog(variables.slice(0, 2));
    plots.setLiveWatchIds(['watch']);
    await recorder.open();
    assert.equal(requests.at(-1).command, 'cortexKit.sample.focus');
    recorder.resolveWebviewView(vscode.window.createWebviewPanel());
    assert.ok(recorder.panel.webview.html.includes('采样记录 / CSV 曲线'));
    assert.ok(!recorder.panel.webview.html.includes('独立窗口'));
    await recorder.handle({ type: 'select' });
    await recorder.handle({ type: 'start', rate: 100, duration: 0 });
    assert.equal(recorder.isRecording, true);
    assert.deepEqual(requests.at(-1).ids, ['a', 'b']);
    assert.deepEqual(requests.at(-1).backgroundIds, ['watch']);
    const batch = { sessionId: 's', programGeneration: 1, streamEpoch: 1, batchSequence: 1, channelIds: ['a', 'b'], sampleCount: 30,
      startTimestampNs: 5_000_000_000, samplePeriodNs: 1_000_000, droppedFrames: 0, values: Array.from({ length: 60 }, (_, i) => i) };
    plots.acceptBatch(batch);
    await recorder.handle({ type: 'stop' });
    assert.equal(recorder.isRecording, false);
    const table = parseCsv(fs.readFileSync(filename, 'utf8'));
    assert.equal(table.rows.length, 3);
    assert.deepEqual(table.rows[1], [.01, 5_010_000_000, 1, 20, 21]);
    assert.deepEqual(requests.at(-1).ids, ['watch']);
    assert.equal(requests.at(-1).requestedSamplesPerSecond, 20);
    await recorder.handle({ type: 'import' });
    const curves = messages.filter(message => message.type === 'curves').at(-1);
    assert.equal(curves.live, false);
    assert.deepEqual(curves.curves[0].points, [[0, 0], [.01, 20], [.02, 40]]);
    // A failed subscription must close the file and restore the existing consumer.
    const realSet = plots.setRecordingSubscription.bind(plots);
    plots.setRecordingSubscription = async (ids: string[], rate: number) => { if (ids.length) { throw new Error('probe unavailable'); } await realSet(ids, rate); };
    await assert.rejects(recorder.handle({ type: 'start', rate: 200, duration: 0 }), /probe unavailable/);
    assert.equal(recorder.isRecording, false);
    assert.deepEqual(requests.at(-1).ids, ['watch']);
    plots.setRecordingSubscription = realSet;
    plots.setSession(undefined);
    plots.waitForDataChannel = async () => {};
    await recorder.handle({ type: 'start', rate: 100, duration: .02 });
    assert.equal(launchConfig.request, 'attach');
    assert.equal(launchConfig.plotOnly, true);
    assert.equal(launchConfig.preLaunchTask, undefined);
    assert.equal(launchConfig.postDebugTask, undefined);
    assert.deepEqual(launchConfig.flashing, { enabled: false, verify: false, resetAfter: false });
    await new Promise(resolve => setTimeout(resolve, 80));
    await recorder.stop();
    assert.equal(recorder.isRecording, false);
    await recorder.handle({ type: 'start', rate: 100, duration: 0 });
    plots.setState({ sessionId: 's', programGeneration: 1, streamEpoch: 1, lastError: 'probe read failed' });
    await recorder.stop();
    assert.equal(recorder.isRecording, false);
    closeDuringSave = true;
    const originalFile = fs.readFileSync(filename, 'utf8');
    await recorder.handle({ type: 'start', rate: 100, duration: 0 });
    assert.equal(recorder.isRecording, false);
    assert.equal(fs.readFileSync(filename, 'utf8'), originalFile);
  } finally {
    recorder.dispose(); plots.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
