import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendDerivedChannels,
  expandVariableSelections,
  expressionDescriptor,
  flattenVariables,
  isPlottableVariable,
  isVariableSelection,
  reorderCharts,
  resolveSubscriptionIds,
  restoreLayoutExpressions,
} from '../plotModel';
import { ChartLayout, SampleBatch, VariableDescriptor } from '../types';

function leaf(id: string, name: string, expression: string, address: number): VariableDescriptor {
  return { id, name, expression, typeName: 'float', address, byteWidth: 4, scalarKind: 'float32', writable: true, children: [] };
}

const member = leaf('dwarf:20000100:telemetry.speed', 'speed', 'telemetry.speed', 0x20000100);
const element = leaf('dwarf:20000104:telemetry.history[0]', '[0]', 'telemetry.history[0]', 0x20000104);
const catalogTree: VariableDescriptor[] = [{
  id: 'dwarf:20000100:telemetry', name: 'telemetry', expression: 'telemetry', typeName: 'Telemetry', address: 0x20000100,
  byteWidth: 8, scalarKind: 'unsigned', writable: true, children: [member, {
    id: 'dwarf:20000104:telemetry.history', name: 'history', expression: 'telemetry.history', typeName: 'float[1]', address: 0x20000104,
    byteWidth: 4, scalarKind: 'unsigned', writable: true, children: [element],
  }],
}];

test('structure members and array elements become independently plottable leaves', () => {
  const flattened = flattenVariables(catalogTree);
  assert.deepEqual(flattened.filter(isPlottableVariable).map(item => item.expression), [
    'telemetry.speed',
    'telemetry.history[0]',
  ]);
});

test('selecting a structure recursively adds its scalar leaves without duplicates', () => {
  assert.equal(isVariableSelection(catalogTree[0]), true);
  assert.deepEqual(
    expandVariableSelections([catalogTree[0], member]).map(item => item.expression),
    ['telemetry.speed', 'telemetry.history[0]'],
  );
});

test('dragging a chart reorders it before or after the drop target', () => {
  const layouts: ChartLayout[] = [
    { id: 'a', title: 'A', mode: 'time', variableIds: [] },
    { id: 'b', title: 'B', mode: 'time', variableIds: [] },
    { id: 'c', title: 'C', mode: 'time', variableIds: [] },
  ];
  assert.deepEqual(reorderCharts(layouts, 'c', 'a', false).map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(reorderCharts(layouts, 'a', 'b', true).map(item => item.id), ['b', 'a', 'c']);
});

test('plot subscriptions deduplicate shared leaves and expand expression dependencies', () => {
  const expression = expressionDescriptor('telemetry.speed + telemetry.history[0]');
  const charts: ChartLayout[] = [
    { id: 'one', title: 'One', mode: 'time', variableIds: [member.id, expression.id] },
    { id: 'two', title: 'Two', mode: 'fft', variableIds: [member.id, element.id, 'missing'] },
  ];
  assert.deepEqual(resolveSubscriptionIds(charts, [...flattenVariables(catalogTree), expression]), [member.id, element.id]);
});

test('real interleaved sample batches retain leaf values and append derived channels per frame', () => {
  const expression = expressionDescriptor('telemetry.speed + telemetry.history[0]');
  const charts: ChartLayout[] = [{ id: 'one', title: 'One', mode: 'time', variableIds: [member.id, element.id, expression.id] }];
  const batch: SampleBatch = {
    sessionId: 'real-session', programGeneration: 2, streamEpoch: 4, batchSequence: 7,
    sampleCount: 2, startTimestampNs: 100, samplePeriodNs: 10, droppedFrames: 0,
    channelIds: [member.id, element.id], values: [1, 10, 2, 20],
  };
  const result = appendDerivedChannels(batch, charts, [...flattenVariables(catalogTree), expression]);
  assert.deepEqual(result.channelIds, [member.id, element.id, expression.id]);
  assert.deepEqual(result.values, [1, 10, 11, 2, 20, 22]);
});

test('persisted expression ids restore descriptors after an extension reload', () => {
  const charts: ChartLayout[] = [{ id: 'one', title: 'One', mode: 'both', variableIds: ['expr:telemetry.speed * 2'] }];
  assert.deepEqual(restoreLayoutExpressions(charts), [expressionDescriptor('telemetry.speed * 2')]);
});
