import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('probe setup replaces a stale selector while preserving firmware and other launch entries', async () => {
  const original = [
    { type: 'cortex-kit', name: 'Live', chip: 'STM32H723VG', programBinary: 'app.elf', plotOnly: true, probe: { selector: 'old ST-Link' }, acquisition: { historySeconds: 30 }, flashing: { enabled: false } },
    { type: 'cortex-kit', name: 'Flash', probe: { selector: 'old ST-Link' } },
    { type: 'cortex-debug', name: 'Other' },
  ];
  let saved: any;
  let picks = 0;
  let cancelAt = -1;
  const exports: any = {};
  const vscode = {
    workspace: { workspaceFolders: [{ uri: 'workspace' }], getConfiguration: () => ({ get: () => original, update: async (_key: string, value: unknown) => { saved = value; } }) },
    ConfigurationTarget: { WorkspaceFolder: 3 },
    window: {
      showQuickPick: async (items: any[]) => ++picks === cancelAt ? undefined : items.find(item => item.key === 'cmsisdap') ?? items[0],
      showInputBox: async () => '50000', showInformationMessage() {},
    },
  };
  runInNewContext(readFileSync(path.join(__dirname, '../projectConfig.js'), 'utf8'), {
    exports, require: (name: string) => name === 'vscode' ? vscode : name === 'node:util' ? {
      promisify: () => async () => ({ stdout: JSON.stringify([{ identifier: 'Horco CMSIS-DAP', selector: 'Horco CMSIS-DAP,SN:123', probeType: 'CMSIS-DAP', serialNumber: '123' }]) }),
    } : require(name === './launchConfig' ? '../launchConfig' : name),
  });
  await exports.configureProbe('adapter.exe');
  assert.equal(saved[0].probe.selector, 'Horco CMSIS-DAP,SN:123');
  assert.equal(saved[0].probe.speedKHz, 50000);
  assert.equal(saved[0].acquisition.requestedSamplesPerSecond, 100000);
  assert.equal(saved[0].acquisition.historySeconds, 30);
  assert.equal(saved[0].programBinary, 'app.elf');
  assert.equal(saved[0].chip, 'STM32H723VG');
  assert.equal(saved[0].plotOnly, true);
  assert.equal(saved[0].flashing, original[0].flashing);
  assert.equal(saved[1], original[1]);
  assert.equal(saved[2], original[2]);
  assert.equal(original[0].probe?.selector, 'old ST-Link');
  saved = undefined;
  picks = 0;
  cancelAt = 2;
  await exports.configureProbe('adapter.exe');
  assert.equal(saved, undefined);
});
