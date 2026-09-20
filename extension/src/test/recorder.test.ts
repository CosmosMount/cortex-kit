import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

test('recorder delegates live CSV work to the Rust data core', async () => {
  const messages: any[] = [], subscriptions: any[] = [], starts: any[] = [];
  class Emitter {
    event = (_callback: (value?: unknown) => void) => ({ dispose() {} });
  }
  const output = { fsPath: path.join(process.cwd(), 'capture.csv'), scheme: 'file' };
  const panel = {
    visible: true,
    webview: { cspSource: 'test', asWebviewUri: (value: any) => value, postMessage: (message: any) => { messages.push(message); }, onDidReceiveMessage: () => ({ dispose() {} }), html: '' },
    onDidChangeVisibility() {}, onDidDispose() {},
  };
  const vscode = {
    Uri: { joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath ?? '.', ...parts) }), file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    window: { showQuickPick: async (items: any[]) => items, showSaveDialog: async () => output },
    commands: { executeCommand: async () => {} }, debug: { startDebugging: async () => true },
  };
  const modules = require('node:module');
  const original = modules._load;
  modules._load = function(name: string, ...args: any[]) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  const { SampleRecorder } = require('../recorder');
  modules._load = original;
  const variables = ['a', 'b'].map((id, index) => ({ id, name: id, expression: id, typeName: 'float', address: 0x20000000 + index * 4, byteWidth: 4, scalarKind: 'float32', writable: true, children: [] }));
  const plots = {
    session: { id: 'mock', configuration: {}, workspaceFolder: { uri: { fsPath: process.cwd() } } },
    onDidChangeSession: new Emitter().event, getVariables: () => variables,
    setRecordingSubscription: async (ids: string[], rate?: number) => { subscriptions.push({ ids, rate }); },
    startNativeRecording: async (spec: unknown) => { starts.push(spec); },
    stopNativeRecording: async () => ({ rows: 12, actualHz: 100, elapsedSeconds: .11, dropped: 0, overflowFrames: 0, connectionBreaks: 0, recording: false, closing: false }),
    nativeRecordingStatus: async () => ({ rows: 0, actualHz: 0, elapsedSeconds: 0, dropped: 0, overflowFrames: 0, connectionBreaks: 0, recording: true, closing: false }),
    nativeRecordingPreview: async () => undefined, waitForDataChannel: async () => {},
  };
  const storage = new Map<string, unknown>();
  const context = { extensionUri: { fsPath: process.cwd() }, workspaceState: { get: (key: string, fallback: unknown) => storage.get(key) ?? fallback, update: async (key: string, value: unknown) => { storage.set(key, value); } } };
  const recorder = new SampleRecorder(context as any, plots as any);
  try {
    recorder.resolveWebviewView(panel as any);
    await recorder.handle({ type: 'select' });
    await recorder.handle({ type: 'start', rate: 100 });
    assert.deepEqual(starts[0], { path: output.fsPath, ids: ['a', 'b'], names: ['a', 'b'], rate: 100 });
    assert.deepEqual(subscriptions.at(-1), { ids: ['a', 'b'], rate: 100 });
    assert.equal(recorder.isRecording, true);
    await recorder.handle({ type: 'stop' });
    assert.equal(recorder.isRecording, false);
    assert.deepEqual(subscriptions.at(-1).ids, []);
    assert.equal(messages.filter(message => message.type === 'state').at(-1).rows, 12);
  } finally { recorder.dispose(); }
});
