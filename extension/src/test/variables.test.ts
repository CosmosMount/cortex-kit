import assert from 'node:assert/strict';
import test from 'node:test';
import { expandVariableSelections } from '../plotModel';
import { expressionDependencies } from '../expression';
import { VariableDescriptor } from '../types';

test('scoped instance fields and array members work in plot expressions', () => {
  const name = 'Motor::Instance::instance.samples[0].value';
  assert.deepEqual(expressionDependencies(`${name} * 2`), [name]);
});

test('same-named instances keep distinct tree identities across value refresh and select their own fields', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const modules = require('node:module');
  const original = modules._load;
  class TreeItem { id?: string; description?: string; tooltip?: unknown; contextValue?: string; iconPath?: unknown; constructor(public label: string, public collapsibleState: number) {} }
  class EventEmitter<T> {
    private readonly listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.splice(0); }
  }
  const vscode = {
    TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeIcon: class {},
    MarkdownString: class { constructor(public value: string) {} }, EventEmitter,
  };
  modules._load = function(name: string, ...args: unknown[]) {
    return name === 'vscode' ? vscode : original.call(this, name, ...args);
  };
  try {
    const { LiveWatchProvider, VariablesProvider } = require('../views');
    const instance = (address: number): VariableDescriptor => ({
      id: `dwarf:${address}:instance`, name: 'instance', expression: 'instance', typeName: 'Motor',
      address, byteWidth: 4, scalarKind: 'unsigned', writable: true,
      children: [{ id: `dwarf:${address}:instance.speed`, name: 'speed', expression: 'instance.speed',
        typeName: 'float', address, byteWidth: 4, scalarKind: 'float32', writable: true, children: [] }],
    });
    const first = instance(0x20000100), second = instance(0x20000200);
    const provider = new VariablesProvider([first, second]);
    const roots = provider.getChildren();
    assert.notEqual(roots[0].id, roots[1].id);
    assert.equal(roots[0].id, first.id);
    provider.setExpanded(second, true);
    assert.deepEqual(provider.getVisibleScalarVariables(), second.children);
    const child = provider.getChildren(roots[1])[0];
    provider.setValues([{ id: child.id, value: 12.5 }]);
    const refreshed = provider.getChildren();
    assert.equal(refreshed[1].id, roots[1].id);
    assert.equal(provider.getChildren(refreshed[1])[0].id, child.id);
    assert.match(provider.getChildren(refreshed[1])[0].description, /12.5/);
    assert.deepEqual(expandVariableSelections([refreshed[1].variable]).map(v => v.id), [child.id]);
    assert.deepEqual(provider.getVisibleScalarVariables(), second.children);
    const manyGlobals = Array.from({ length: 513 }, (_, index) => ({
      ...first.children[0], id: `global:${index}`, name: `global${index}`,
    }));
    provider.setVariables([...manyGlobals, second]);
    provider.setExpanded(second, true);
    assert.equal(provider.getVisibleScalarVariables().length, 512);
    assert.equal(provider.getVisibleScalarVariables()[0].id, child.id);

    const live = new LiveWatchProvider({
      get: () => ['mock.ramp'], update: async () => {}, keys: () => [],
    });
    const ramp: VariableDescriptor = { ...first.children[0], id: 'mock.ramp', expression: 'control.ramp' };
    live.setCatalog([ramp]);
    let refreshes = 0;
    live.onDidChangeTreeData(() => { refreshes += 1; });
    live.setValues([{ id: ramp.id, value: 0.25, timestampNs: 1_000_000_000, source: 'stream' }]);
    const firstLiveDescription = String(live.getChildren()[0].description);
    live.setValues([{ id: ramp.id, value: 0.5, timestampNs: 1_050_000_000, source: 'stream' }]);
    const secondLiveDescription = String(live.getChildren()[0].description);
    assert.match(firstLiveDescription, /0\.25.*t=1\.000 s/);
    assert.match(secondLiveDescription, /0\.5.*t=1\.050 s/);
    assert.notEqual(firstLiveDescription, secondLiveDescription);
    assert.equal(refreshes, 0, 'updates coalesce behind the initial catalog refresh');
    t.mock.timers.tick(250);
    assert.equal(refreshes, 1);
    assert.equal(live.getChildren()[0].id, ramp.id);
    for (let index = 0; index < 20; index++) {
      live.setValues([{ id: ramp.id, value: index, source: 'stream' }]);
      t.mock.timers.tick(50);
    }
    assert.equal(refreshes, 5, 'continuous samples must not postpone refresh indefinitely');
    live.dispose();
    t.mock.timers.tick(1000);
    assert.equal(refreshes, 5, 'disposing cancels pending refresh');
  } finally { modules._load = original; }
});
