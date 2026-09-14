import assert from 'node:assert/strict';
import test from 'node:test';
import { expandVariableSelections } from '../plotModel';
import { evaluateExpression, expressionDependencies } from '../expression';
import { VariableDescriptor } from '../types';

test('scoped instance fields and array members work in plot expressions', () => {
  const name = 'Motor::Instance::instance.samples[0].value';
  assert.deepEqual(expressionDependencies(`${name} * 2`), [name]);
  assert.equal(evaluateExpression(`${name} * 2`, new Map([[name, 3]])), 6);
});

test('same-named instances keep distinct tree identities across value refresh and select their own fields', () => {
  const modules = require('node:module');
  const original = modules._load;
  class TreeItem { constructor(public label: string, public collapsibleState: number) {} }
  const vscode = {
    TreeItem, TreeItemCollapsibleState: { None: 0, Collapsed: 1 }, ThemeIcon: class {},
    EventEmitter: class { event = () => {}; fire() {} },
  };
  modules._load = function(name: string, ...args: unknown[]) {
    return name === 'vscode' ? vscode : original.call(this, name, ...args);
  };
  try {
    const { VariablesProvider } = require('../views');
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
  } finally { modules._load = original; }
});
