import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LiveWatchProvider } from '../views';
import { VariableDescriptor } from '../types';

// Run in a real Extension Host with tests/fixtures/live-watch-host as the
// development extension. Counts workbench-driven reads, never manual reads.
export async function run(): Promise<void> {
  const variable: VariableDescriptor = { id: 'generic.counter', name: 'counter', expression: 'counter',
    typeName: 'unsigned int', address: 0x20000000, byteWidth: 4, scalarKind: 'unsigned', writable: true, children: [] };
  const results: Array<{ legacy: boolean; updates: number; paints: number; descriptions: string[] }> = [];
  for (const legacy of [true, false]) {
    const provider = new LiveWatchProvider({ get: <T>() => [variable.id] as T, update: async () => {}, keys: () => [] });
    provider.setCatalog([variable]);
    const unthrottled = new vscode.EventEmitter<void>();
    const descriptions: string[] = [];
    let measuring = false;
    const view = vscode.window.createTreeView<vscode.TreeItem>('cortexKit.refreshRegression', { treeDataProvider: {
      onDidChangeTreeData: legacy ? unthrottled.event : provider.onDidChangeTreeData,
      getChildren: parent => provider.getChildren(parent),
      getTreeItem: item => {
        if (measuring && item.id === variable.id) { descriptions.push(String(item.description)); }
        return provider.getTreeItem(item);
      },
    } });
    let timer: NodeJS.Timeout | undefined;
    try {
      await vscode.commands.executeCommand('cortexKit.refreshRegression.focus');
      await new Promise(resolve => setTimeout(resolve, 750));
      assert.ok(view.visible, 'the real workbench tree must be visible');
      measuring = true;
      let updates = 0;
      timer = setInterval(() => {
        updates++;
        provider.setValues([{ id: variable.id, value: updates, timestampNs: updates * 50_000_000, source: 'stream' }]);
        if (legacy) { unthrottled.fire(); }
      }, 50);
      await new Promise(resolve => setTimeout(resolve, 2500));
      measuring = false; // Check while samples are still flowing, not after debounce settles.
      results.push({ legacy, updates, paints: descriptions.length, descriptions });
    } finally {
      clearInterval(timer); view.dispose(); provider.dispose(); unthrottled.dispose();
    }
  }
  console.log(`LIVE_WATCH_HOST_RESULT ${JSON.stringify(results)}`);
  assert.ok(results[0].updates >= 30);
  assert.ok(results[0].paints <= 2, 'legacy 20 Hz events reproduce refresh starvation');
  assert.ok(results[1].paints >= 6, 'fixed tree keeps repainting during continuous samples');
  assert.ok(new Set(results[1].descriptions).size >= 6, 'workbench receives changing values and timestamps');
}
