import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredProgramCandidates, convertCortexDebugConfiguration, suggestedProbeRsChip } from '../launchConfig';

test('offline program lookup prefers Cortex Kit and also understands Cortex-Debug executable', () => {
  const result = configuredProgramCandidates([
    { type: 'cortex-debug', name: 'Legacy', executable: '${workspaceFolder}/legacy.elf' },
    { type: 'other', executable: 'ignored.elf' },
    { type: 'cortex-kit', name: 'Native', programBinary: '${workspaceFolder}/native.elf' },
  ]);
  assert.deepEqual(result.map(item => [item.debugType, item.configuredPath]), [
    ['cortex-kit', '${workspaceFolder}/native.elf'],
    ['cortex-debug', '${workspaceFolder}/legacy.elf'],
  ]);
});

test('STM32 package suffix is converted to a probe-rs target suggestion', () => {
  assert.equal(suggestedProbeRsChip('STM32H723VGTx'), 'STM32H723VG');
  assert.equal(suggestedProbeRsChip('STM32H723VGT6'), 'STM32H723VG');
  assert.equal(suggestedProbeRsChip('nRF52840_xxAA'), 'nRF52840_xxAA');
});

test('Cortex-Debug launch fields migrate without OpenOCD dependencies', () => {
  const result = convertCortexDebugConfiguration({
    type: 'cortex-debug', request: 'launch', name: 'STM32 Debug', cwd: '${workspaceFolder}',
    executable: '${workspaceFolder}/build/app.elf', device: 'STM32H723VGTx',
    servertype: 'openocd', configFiles: ['interface/stlink.cfg', 'target/stm32h7x.cfg'],
  });
  assert.deepEqual(result, {
    type: 'cortex-kit', request: 'launch', name: 'STM32 Debug (Cortex Kit)', cwd: '${workspaceFolder}',
    chip: 'STM32H723VG', programBinary: '${workspaceFolder}/build/app.elf', svdFile: null,
    probe: { selector: 'auto', protocol: 'swd', speedKHz: 10000, connectUnderReset: false },
    flashing: { enabled: true, verify: true, resetAfter: true },
    stopOnEntry: true, runToEntryPoint: 'main',
    acquisition: { requestedSamplesPerSecond: 5000, historySeconds: 30 },
  });
});
