import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { isDwarfImage, resolveConfiguredPath } from '../offlineCatalog';

test('configured ELF paths expand before a debug session starts', () => {
  const root = path.resolve('D:/firmware');
  assert.equal(resolveConfiguredPath('${workspaceFolder}/build/app.elf', root), path.normalize(path.join(root, 'build/app.elf')));
  assert.equal(resolveConfiguredPath('${env:BUILD_DIR}/app.axf', root, { BUILD_DIR: path.join(root, 'output') }), path.normalize(path.join(root, 'output/app.axf')));
});

test('only images capable of carrying DWARF are inspected for offline variables', () => {
  assert.equal(isDwarfImage('app.ELF'), true);
  assert.equal(isDwarfImage('app.axf'), true);
  assert.equal(isDwarfImage('app.hex'), false);
});
