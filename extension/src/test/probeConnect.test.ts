import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const st = { identifier: 'STLink V2-1', selector: 'STLink V2-1,SN:st', probeType: '"ST-Link"', serialNumber: 'st' };
const dap = { identifier: 'Horco CMSIS-DAP', selector: 'Horco CMSIS-DAP,SN:dap', probeType: '"CMSIS-DAP"', serialNumber: 'dap' };

function harness(options: { family?: string; devices?: typeof dap[]; cancelDevice?: boolean; retry?: boolean; scanError?: boolean; startResult?: boolean } = {}) {
  const config = { type: 'cortex-kit', name: 'Firmware', chip: 'STM32H723VG', programBinary: 'firmware.elf', request: 'launch', preLaunchTask: 'build', postDebugTask: 'cleanup', flashing: { enabled: true }, probe: { selector: 'stale', speedKHz: 50000, protocol: 'swd', connectUnderReset: true }, acquisition: { requestedSamplesPerSecond: 100000 }, svdFile: 'chip.svd' };
  const state = { saved: undefined as any, connection: undefined as any, scans: 0, warnings: [] as string[], errors: [] as string[], shownDevices: [] as any[] };
  const vscode = {
    workspace: { workspaceFolders: [{ uri: 'workspace' }], getConfiguration: () => ({ get: () => [config, { type: 'cortex-debug', name: 'Other' }], update: async (_key: string, value: unknown) => { state.saved = value; } }) },
    ConfigurationTarget: { WorkspaceFolder: 3 },
    debug: { startDebugging: async (_folder: unknown, connection: unknown) => { state.connection = connection; return options.startResult ?? true; } },
    window: {
      showQuickPick: async (items: any[]) => {
        if (items[0].key) { return items.find(item => item.key === (options.family ?? 'cmsisdap')); }
        state.shownDevices = items;
        return options.cancelDevice ? undefined : items[items.length - 1];
      },
      showWarningMessage: async (message: string) => { state.warnings.push(message); return options.retry && state.scans === 1 ? 'Retry' : undefined; },
      showErrorMessage: async (message: string) => { state.errors.push(message); return undefined; },
    },
  };
  const exports: any = {};
  runInNewContext(readFileSync(path.join(__dirname, '../projectConfig.js'), 'utf8'), {
    exports, require: (name: string) => name === 'vscode' ? vscode : name === 'node:util' ? {
      promisify: () => async () => {
        state.scans++;
        if (options.scanError) { throw new Error('adapter missing'); }
        return { stdout: JSON.stringify(options.retry && state.scans === 1 ? [st] : options.devices ?? [st, dap]) };
      },
    } : require(name === './launchConfig' ? '../launchConfig' : name),
  });
  return { config, state, run: () => exports.selectProbeAndConnect('adapter.exe') };
}

for (const [family, expected] of [['cmsisdap', dap], ['stlink', st]] as const) {
  test(`connect selects only ${family} and preserves settings while starting an attach session`, async () => {
    const { run, state, config } = harness({ family });
    await run();
    assert.equal(state.saved[0].probe.selector, expected.selector);
    assert.equal(state.saved[0].probe.speedKHz, 50000);
    assert.equal(state.saved[0].acquisition, config.acquisition);
    assert.equal(state.saved[0].flashing, config.flashing);
    assert.equal(state.saved[0].preLaunchTask, 'build');
    assert.equal(state.saved[1].type, 'cortex-debug');
    assert.equal(state.connection.probe.selector, expected.selector);
    assert.equal(state.connection.request, 'attach');
    assert.equal(state.connection.flashing.enabled, false);
    assert.equal(state.connection.probe.connectUnderReset, false);
    assert.equal(state.connection.stopOnEntry, false);
    assert.equal(state.connection.plotOnly, true);
    assert.ok(!('preLaunchTask' in state.connection));
    assert.ok(!('postDebugTask' in state.connection));
    assert.equal(state.connection.programBinary, 'firmware.elf');
    assert.equal(state.connection.svdFile, 'chip.svd');
  });
}

test('missing selected family never binds the other type and can rescan', async () => {
  const absent = harness({ devices: [st] });
  await absent.run();
  assert.equal(absent.state.saved, undefined);
  assert.equal(absent.state.connection, undefined);
  assert.match(absent.state.warnings[0], /No DAPLink/);
  const retry = harness({ retry: true });
  await retry.run();
  assert.equal(retry.state.scans, 2);
  assert.equal(retry.state.connection.probe.selector, dap.selector);
});

test('multiple matching probes require a device choice; cancellation and duplicates do not save', async () => {
  const second = { ...dap, selector: 'Horco CMSIS-DAP,SN:second', serialNumber: 'second' };
  const selected = harness({ devices: [st, dap, second] });
  await selected.run();
  assert.equal(selected.state.shownDevices.length, 2);
  assert.equal(selected.state.saved[0].probe.selector, second.selector);
  const cancelled = harness({ devices: [dap, second], cancelDevice: true });
  await cancelled.run();
  assert.equal(cancelled.state.saved, undefined);
  const duplicate = harness({ devices: [dap, dap] });
  await duplicate.run();
  assert.equal(duplicate.state.saved, undefined);
  assert.match(duplicate.state.errors[0], /identical selectors/);
});

test('detection failures and unsuccessful debug starts are reported accurately', async () => {
  const detection = harness({ scanError: true });
  await detection.run();
  assert.match(detection.state.errors[0], /adapter missing/);
  assert.equal(detection.state.saved, undefined);
  const failed = harness({ startResult: false });
  await failed.run();
  assert.equal(failed.state.saved[0].probe.selector, dap.selector);
  assert.match(failed.state.errors[0], /session did not start/);
});
