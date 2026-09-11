import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** Extension Host entry point used by the local VS Code smoke command. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('cortex-kit.cortex-kit');
  assert.ok(extension, 'Cortex Kit development extension was not discovered');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('cortexKit.configureProject'));
  assert.ok(commands.includes('cortexKit.importCortexDebug'));
  assert.ok(commands.includes('cortexKit.mockDebug'));
  assert.ok(commands.includes('cortexKit.openPlots'));
  assert.ok(commands.includes('cortexKit.searchVariables'));
  assert.ok(commands.includes('cortexKit.addLiveWatch'));
  assert.ok(commands.includes('cortexKit.writeLiveWatch'));

  const status = await vscode.commands.executeCommand<{ nodeCount: number; plottableCount: number; description?: string }>('cortexKit.internal.variableCatalogStatus');
  assert.ok(status, 'Offline variable catalog status command did not respond');
  if (vscode.workspace.workspaceFolders?.some(folder => folder.name.toLowerCase() === 'wbr_2026')) {
    assert.ok(status.plottableCount > 0, `Expected wbr_2026 ELF globals before debug, got ${JSON.stringify(status)}`);
  }
  console.log(`Cortex Kit offline catalog: ${JSON.stringify(status)}`);
}
