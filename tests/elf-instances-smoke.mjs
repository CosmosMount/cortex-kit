import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = process.env.ARM_GXX ?? 'arm-none-eabi-g++';
const backend = process.env.CORTEX_KIT_BACKEND ?? path.join(root, 'target/debug', process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap');
const available = spawnSync(compiler, ['--version'], { windowsHide: true }).status === 0;
for (const version of [4, 5]) {
  test(`DWARF ${version} C++ instances have scoped, expandable, plottable members`, { skip: !available }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'cortex-kit-instances-'));
    try {
      const elf = path.join(temporary, 'instances.elf');
      execFileSync(compiler, ['-g', `-gdwarf-${version}`, '-O1', '-nostdlib', '-Wl,-e,main',
        path.join(root, 'tests/fixtures/global-instances.cpp'), '-o', elf], { windowsHide: true });
      const catalog = JSON.parse(execFileSync(backend, ['--inspect-elf', elf], { encoding: 'utf8', windowsHide: true }));
      const names = ['Motor::instance', 'Motor::Instance::instance', 'Sensor::Instance::instance', 'robot::global'];
      for (const name of names) {
        const matches = catalog.filter(v => v.name === name);
        assert.equal(matches.length, 1, name);
        const instance = matches[0];
        const samples = instance.children.find(v => v.name === 'samples');
        assert.equal(samples.children.length, 2);
        const value = samples.children[1].children.find(v => v.name === 'value');
        assert.equal(value.expression, `${name}.samples[1].value`);
        assert.equal(value.address, instance.address + 8);
        assert.equal(value.scalarKind, 'float32');
        assert.equal(value.byteWidth, 4);
        assert.deepEqual(value.children, []);
        assert.equal(catalog.filter(v => v.address === instance.address && v.typeName.startsWith('data[')).length, 0);
      }
      const pointer = catalog.find(v => v.name === 'robot::motor_pointer');
      assert.ok(pointer);
      assert.match(pointer.typeName, /Motor \*$/);
      const pointedValue = pointer.children.find(v => v.name === 'samples').children[1].children.find(v => v.name === 'value');
      assert.equal(pointedValue.expression, 'robot::motor_pointer->samples[1].value');
      assert.equal(pointedValue.address, undefined);
      assert.equal(pointedValue.pointerAddress, pointer.address);
      assert.equal(pointedValue.pointerOffset, 8);
      assert.equal(pointedValue.scalarKind, 'float32');
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
