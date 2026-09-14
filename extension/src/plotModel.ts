import { evaluateExpression, expressionDependencies } from './expression';
import { ChartLayout, SampleBatch, VariableDescriptor } from './types';

export function flattenVariables(values: VariableDescriptor[]): VariableDescriptor[] {
  return values.flatMap(value => [value, ...flattenVariables(value.children)]);
}

export function isPlottableVariable(value: VariableDescriptor): boolean {
  return value.id.startsWith('expr:') || (
    (value.address !== undefined || value.pointerAddress !== undefined)
    && value.children.length === 0
    && [1, 2, 4, 8].includes(value.byteWidth)
  );
}

export function plottableLeaves(value: VariableDescriptor): VariableDescriptor[] {
  if (isPlottableVariable(value)) { return [value]; }
  return value.children.flatMap(plottableLeaves);
}

export function isVariableSelection(value: VariableDescriptor): boolean {
  return plottableLeaves(value).length > 0;
}

export function expandVariableSelections(values: VariableDescriptor[]): VariableDescriptor[] {
  const result = new Map<string, VariableDescriptor>();
  for (const value of values) {
    for (const leaf of plottableLeaves(value)) { result.set(leaf.id, leaf); }
  }
  return [...result.values()];
}

export function reorderCharts(
  layouts: ChartLayout[],
  sourceId: string,
  targetId: string,
  after: boolean,
): ChartLayout[] {
  if (sourceId === targetId) { return [...layouts]; }
  const source = layouts.find(item => item.id === sourceId);
  if (!source || !layouts.some(item => item.id === targetId)) { return [...layouts]; }
  const result = layouts.filter(item => item.id !== sourceId);
  const targetIndex = result.findIndex(item => item.id === targetId);
  result.splice(targetIndex + (after ? 1 : 0), 0, source);
  return result;
}

export function expressionDescriptor(expression: string): VariableDescriptor {
  return {
    id: `expr:${expression}`,
    name: expression,
    expression,
    typeName: 'expression',
    byteWidth: 8,
    scalarKind: 'float64',
    writable: false,
    children: [],
  };
}

export function restoreLayoutExpressions(layouts: ChartLayout[]): VariableDescriptor[] {
  const ids = new Set(layouts.flatMap(chart => chart.variableIds).filter(id => id.startsWith('expr:')));
  return [...ids].map(id => expressionDescriptor(id.slice('expr:'.length)));
}

export function resolveSubscriptionIds(layouts: ChartLayout[], catalog: VariableDescriptor[]): string[] {
  const byId = new Map(catalog.map(variable => [variable.id, variable]));
  const byExpression = new Map(
    catalog
      .filter(variable => !variable.id.startsWith('expr:'))
      .flatMap(variable => [[variable.expression, variable] as const, [variable.name, variable] as const]),
  );
  const resolved: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  };

  for (const id of new Set(layouts.flatMap(chart => chart.variableIds))) {
    const variable = byId.get(id);
    if (!variable) { continue; }
    if (!variable.id.startsWith('expr:')) {
      add(variable.id);
      continue;
    }
    try {
      for (const dependency of expressionDependencies(variable.expression)) {
        add(byExpression.get(dependency)?.id);
      }
    } catch {
      // A stale persisted expression must not prevent valid direct subscriptions.
    }
  }
  return resolved;
}

export function appendDerivedChannels(batch: SampleBatch, layouts: ChartLayout[], catalog: VariableDescriptor[]): SampleBatch {
  const desiredIds = new Set(layouts.flatMap(chart => chart.variableIds));
  const expressions = catalog.filter(item => item.id.startsWith('expr:') && desiredIds.has(item.id));
  if (!expressions.length) { return batch; }
  const descriptors = new Map(catalog.map(item => [item.id, item]));
  const rawDescriptors = batch.channelIds.map(id => descriptors.get(id));
  const channelIds = [...batch.channelIds, ...expressions.map(item => item.id)];
  const values: number[] = [];
  for (let sample = 0; sample < batch.sampleCount; sample += 1) {
    const environment = new Map<string, number>();
    for (let channel = 0; channel < batch.channelIds.length; channel += 1) {
      const value = batch.values[sample * batch.channelIds.length + channel];
      const descriptor = rawDescriptors[channel];
      if (descriptor) {
        environment.set(descriptor.expression, value);
        environment.set(descriptor.name, value);
      }
      values.push(value);
    }
    for (const expression of expressions) {
      try { values.push(evaluateExpression(expression.expression, environment)); }
      catch { values.push(Number.NaN); }
    }
  }
  return { ...batch, channelIds, values };
}
