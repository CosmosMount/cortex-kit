import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function setup() {
  const messages: any[] = [], writes: any[] = [];
  let cancel = false;
  let pick: (items: any[]) => any[] | undefined = items => [...items].reverse();
  const exports: any = {};
  const layouts = ['a', 'b'].map(id => ({ id, title: id, mode: 'time', variableIds: [id] }));
  const vscode = {
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    Uri: { joinPath: (base: unknown, name: string) => ({ base, name }) },
    workspace: { workspaceFolders: [{ uri: 'workspace' }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), fs: { writeFile: async (uri: unknown, bytes: Buffer) => { writes.push({ uri, bytes }); } } },
    window: { showQuickPick: async (items: any[]) => cancel ? undefined : pick(items), showSaveDialog: async () => cancel ? undefined : { fsPath: 'plot.png' }, showInformationMessage() {}, showErrorMessage() {} },
  };
  runInNewContext(readFileSync(path.join(__dirname, '../plots.js'), 'utf8'), {
    exports, Buffer, setTimeout, clearTimeout,
    require: (name: string) => name === 'vscode' ? vscode : require(name.startsWith('./') ? '../' + name.slice(2) : name),
  });
  const provider = new exports.PlotViewProvider({ workspaceState: { get: (key: string, fallback: unknown) => key === 'cortexKit.plots' ? layouts : fallback, update: async () => {} } });
  provider.activeSession = { id: 'live' };
  provider.plotSubscriptionIds = new Set(['a', 'b']);
  const batch = { sessionId: 'live', programGeneration: 1, streamEpoch: 1, batchSequence: 1, channelIds: ['a', 'b'], sampleCount: 2, startTimestampNs: 1e9, samplePeriodNs: 1e9, values: [1, 2, 3, 4], droppedFrames: 0 };
  provider.acceptBatch(batch); // Capture while the webview does not exist.
  provider.view = { visible: true, webview: { postMessage: (message: any) => messages.push(message) } };
  return { provider, messages, writes, batch, cancel: () => { cancel = true; }, choose: (selection: (items: any[]) => any[]) => { pick = selection; } };
}

test('adding an object to Plot asks for concrete members and adds only the checked leaves', async () => {
  const { provider, choose } = setup();
  try {
    const first = { id: 'first', name: 'first', expression: 'Motor::instance.first', typeName: 'float', address: 0x20000100, byteWidth: 4, scalarKind: 'float32', writable: true, children: [] };
    const second = { ...first, id: 'second', name: 'second', expression: 'Motor::instance.second', address: 0x20000104 };
    const instance = { id: 'instance', name: 'Motor::instance', expression: 'Motor::instance', typeName: 'Motor', address: 0x20000100, byteWidth: 8, scalarKind: 'unsigned', writable: true, children: [first, second] };
    provider.activeSession = undefined;
    provider.layouts[0].variableIds = [];
    choose(items => [items[1]]);
    await provider.addVariables(undefined, instance);
    assert.equal(JSON.stringify(provider.layouts[0].variableIds), JSON.stringify(['second']));
  } finally { provider.dispose(); }
});

test('Plot history survives session end and view recreation, but clears for a new session', () => {
  const { provider, messages } = setup();
  try {
    provider.setSession(undefined);
    assert.equal(provider.history.length, 1);
    assert.ok(!messages.some(message => message.type === 'clearHistory'));
    provider.replayHistory();
    assert.equal(messages.at(-2).type, 'clearHistory');
    assert.equal(messages.at(-1).batch.values.length, 4);
    provider.setSession({ id: 'next' });
    assert.equal(provider.history.length, 0);
    assert.equal(messages.at(-1).type, 'clearHistory');
  } finally { provider.dispose(); }
});

test('multi-Plot export keeps chart order and writes only a matching PNG response to the chosen destination', async () => {
  const { provider, messages, writes } = setup();
  try {
    provider.setSession(undefined);
    await provider.handleMessage({ type: 'exportPlots' });
    const request = messages.at(-1);
    assert.equal(request.type, 'renderExport');
    assert.equal(JSON.stringify(request.chartIds), JSON.stringify(['a', 'b']));
    await provider.handleMessage({ type: 'exportImage', requestId: 'unrequested', dataUrl: png });
    assert.equal(writes.length, 0);
    await provider.handleMessage({ type: 'exportImage', requestId: request.requestId, dataUrl: png });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].uri.fsPath, 'plot.png');
    assert.equal(writes[0].bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(provider.exporting, false);
  } finally { provider.dispose(); }
});

test('Plot export cancellation and invalid image data do not write files', async () => {
  const { provider, messages, writes, cancel } = setup();
  try {
    await provider.handleMessage({ type: 'exportPlots' });
    await assert.rejects(provider.handleMessage({ type: 'exportImage', requestId: messages.at(-1).requestId, dataUrl: 'data:image/png;base64,YmFk' }), /有效的 PNG/);
    assert.equal(provider.exporting, false);
    await provider.handleMessage({ type: 'exportPlots' });
    cancel();
    await provider.handleMessage({ type: 'exportImage', requestId: messages.at(-1).requestId, dataUrl: png });
    await provider.handleMessage({ type: 'exportPlots' });
    assert.equal(provider.exporting, false);
    assert.equal(writes.length, 0);
  } finally { provider.dispose(); }
});
