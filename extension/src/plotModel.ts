import { expressionDependencies } from './expression';
import { ChartLayout, VariableDescriptor } from './types';

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
