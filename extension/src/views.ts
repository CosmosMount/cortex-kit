import * as vscode from 'vscode';
import { flattenLiveWatchCatalog, formatLiveWatchValue } from './liveWatchModel';
import { LiveWatchValue, SessionState, SvdField, SvdPeripheral, SvdRegister, SvdTree, VariableDescriptor } from './types';

export class VariableNode extends vscode.TreeItem {
  constructor(public readonly variable: VariableDescriptor, currentValue?: string) {
    super(variable.name, variable.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.id = variable.id;
    const metadata = `${variable.typeName}${formatVariableAddress(variable, ' @ ')}`;
    this.description = currentValue === undefined ? metadata : `${currentValue} · ${metadata}`;
    this.tooltip = `${variable.expression}\n${this.description}`;
    this.contextValue = (variable.address !== undefined || variable.pointerAddress !== undefined) && !variable.children.length && [1, 2, 4, 8].includes(variable.byteWidth) ? 'cortexKit.variable' : 'cortexKit.variableGroup';
    this.iconPath = new vscode.ThemeIcon(variable.children.length ? 'symbol-struct' : 'symbol-variable');
  }
}

export class VariablesProvider implements vscode.TreeDataProvider<VariableNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private flattened: VariableDescriptor[];
  private readonly values = new Map<string, string>();
  private readonly expanded = new Set<string>();
  constructor(private variables: VariableDescriptor[] = []) { this.flattened = flatten(variables); }
  setVariables(variables: VariableDescriptor[]): void { this.variables = variables; this.flattened = flatten(variables); this.values.clear(); this.expanded.clear(); this.changed.fire(); }
  hasVariables(): boolean { return this.variables.length > 0; }
  getVariables(): VariableDescriptor[] { return this.flattened; }
  setExpanded(variable: VariableDescriptor, expanded: boolean): void { if (expanded) { this.expanded.add(variable.id); } else { this.expanded.delete(variable.id); } }
  getVisibleScalarVariables(limit = 512): VariableDescriptor[] {
    const result: VariableDescriptor[] = [];
    const visit = (items: VariableDescriptor[]) => {
      // Explicitly opened objects take priority over a large list of root scalars.
      for (const item of items) {
        if (result.length >= limit) { return; }
        if (item.children.length && this.expanded.has(item.id)) { visit(item.children); }
      }
      for (const item of items) {
        if (result.length >= limit) { return; }
        if (!item.children.length) {
          if ((item.address !== undefined || item.pointerAddress !== undefined) && [1, 2, 4, 8].includes(item.byteWidth)) { result.push(item); }
        }
      }
    };
    visit(this.variables);
    return result;
  }
  setValues(values: Array<{ id: string; value: number }>): void {
    const byId = new Map(this.flattened.map(variable => [variable.id, variable]));
    for (const item of values) {
      const variable = byId.get(item.id);
      if (variable) { this.values.set(item.id, formatVariableValue(item.value, variable)); }
    }
    this.changed.fire();
  }
  clearValues(): void { if (this.values.size) { this.values.clear(); this.changed.fire(); } }
  getTreeItem(item: VariableNode): vscode.TreeItem { return item; }
  getChildren(parent?: VariableNode): VariableNode[] { return (parent?.variable.children ?? this.variables).map(variable => new VariableNode(variable, this.values.get(variable.id))); }
}

export class LiveWatchNode extends vscode.TreeItem {
  constructor(public readonly variable: VariableDescriptor, public readonly current?: LiveWatchValue) {
    super(variable.expression, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = current?.displayValue ?? (current ? formatLiveWatchValue(current.value, variable.scalarKind) : 'Waiting for samples…');
    this.contextValue = variable.writable ? 'cortexKit.liveWatchWritable' : 'cortexKit.liveWatchReadOnly';
    this.iconPath = new vscode.ThemeIcon(current ? 'pulse' : 'eye');
    const value = current?.displayValue ?? (current ? formatLiveWatchValue(current.value, variable.scalarKind) : '<unavailable>');
    this.tooltip = new vscode.MarkdownString([
      `**${variable.expression}**`,
      '',
      `Value: \`${value}\`  `,
      `Type: \`${variable.typeName}\`  `,
      `Address: \`${formatVariableAddress(variable) || '<dynamic>'}\`  `,
      `Width: ${variable.byteWidth} byte${variable.byteWidth === 1 ? '' : 's'}  `,
      `Access: ${variable.writable ? 'read/write' : 'read-only'}`,
    ].join('\n'));
  }
}

type LiveWatchItem = LiveWatchNode | vscode.TreeItem;

export class LiveWatchProvider implements vscode.TreeDataProvider<LiveWatchItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly selectionChanged = new vscode.EventEmitter<string[]>();
  readonly onDidChangeSelection = this.selectionChanged.event;
  private readonly values = new Map<string, LiveWatchValue>();
  private readonly pendingWrites = new Map<string, { timer: NodeJS.Timeout; latest?: LiveWatchValue }>();
  private readonly selectedIds: string[];
  private catalog = new Map<string, VariableDescriptor>();

  constructor(private readonly workspaceState: vscode.Memento) {
    this.selectedIds = [...new Set(workspaceState.get<string[]>('cortexKit.liveWatch', []))];
  }
  dispose(): void {
    for (const pending of this.pendingWrites.values()) { clearTimeout(pending.timer); }
    this.pendingWrites.clear();
    this.changed.dispose();
    this.selectionChanged.dispose();
  }
  setCatalog(variables: VariableDescriptor[]): void {
    this.catalog = new Map(flattenLiveWatchCatalog(variables).map(variable => [variable.id, variable]));
    this.changed.fire();
  }
  getSelectedIds(): string[] { return [...this.selectedIds]; }
  getSelectedVariables(): VariableDescriptor[] {
    return this.selectedIds.map(id => this.catalog.get(id)).filter((item): item is VariableDescriptor => Boolean(item));
  }
  has(id: string): boolean { return this.selectedIds.includes(id); }
  getCurrent(id: string): LiveWatchValue | undefined { return this.values.get(id); }
  async add(variables: VariableDescriptor[]): Promise<void> {
    let changed = false;
    for (const variable of variables) {
      if (!this.selectedIds.includes(variable.id)) { this.selectedIds.push(variable.id); changed = true; }
    }
    if (changed) { await this.persist(); }
  }
  async remove(variable: VariableDescriptor): Promise<void> {
    const index = this.selectedIds.indexOf(variable.id);
    if (index < 0) { return; }
    this.selectedIds.splice(index, 1);
    this.values.delete(variable.id);
    this.clearPendingWrite(variable.id);
    await this.persist();
  }
  async clear(): Promise<void> {
    if (!this.selectedIds.length) { return; }
    this.selectedIds.splice(0);
    this.values.clear();
    for (const id of this.pendingWrites.keys()) { this.clearPendingWrite(id); }
    await this.persist();
  }
  setValues(values: LiveWatchValue[]): void {
    let changed = false;
    for (const value of values) {
      if (!this.selectedIds.includes(value.id)) { continue; }
      const pending = this.pendingWrites.get(value.id);
      if (pending) { pending.latest = value; continue; }
      this.values.set(value.id, value);
      changed = true;
    }
    if (changed) { this.changed.fire(); }
  }
  setWrittenValue(id: string, value: number, displayValue: string, holdMs = 500): void {
    if (!this.selectedIds.includes(id)) { return; }
    this.clearPendingWrite(id);
    this.values.set(id, { id, value, displayValue, source: 'write' });
    const pending: { timer: NodeJS.Timeout; latest?: LiveWatchValue } = {
      timer: setTimeout(() => {
        this.pendingWrites.delete(id);
        if (pending.latest) { this.values.set(id, pending.latest); }
        this.changed.fire();
      }, holdMs),
    };
    this.pendingWrites.set(id, pending);
    this.changed.fire();
  }
  clearValues(): void {
    for (const id of this.pendingWrites.keys()) { this.clearPendingWrite(id); }
    if (this.values.size) { this.values.clear(); this.changed.fire(); }
  }
  getTreeItem(item: LiveWatchItem): vscode.TreeItem { return item; }
  getChildren(parent?: LiveWatchItem): LiveWatchItem[] {
    if (parent instanceof LiveWatchNode) { return liveWatchDetails(parent.variable, parent.current); }
    if (parent) { return []; }
    if (!this.selectedIds.length) { return [liveWatchMessage('Use + to add variables')]; }
    const nodes: LiveWatchItem[] = this.getSelectedVariables().map(variable => new LiveWatchNode(variable, this.values.get(variable.id)));
    const unavailable = this.selectedIds.length - nodes.length;
    if (unavailable) { nodes.push(liveWatchMessage(`${unavailable} saved variable${unavailable === 1 ? '' : 's'} unavailable in this ELF`)); }
    return nodes;
  }
  private async persist(): Promise<void> {
    await this.workspaceState.update('cortexKit.liveWatch', this.selectedIds);
    this.changed.fire();
    this.selectionChanged.fire(this.getSelectedIds());
  }
  private clearPendingWrite(id: string): void {
    const pending = this.pendingWrites.get(id);
    if (pending) { clearTimeout(pending.timer); this.pendingWrites.delete(id); }
  }
}

export class SessionProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private state?: SessionState;
  setState(state?: SessionState): void { this.state = state; this.changed.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  getChildren(): vscode.TreeItem[] {
    if (!this.state) { return [entry('Status', 'No Cortex Kit session', 'debug-disconnect')]; }
    const target = typeof this.state.targetState === 'string' ? this.state.targetState : `halted: ${this.state.targetState.halted.reason}`;
    const result = [entry('Status', target, target.startsWith('halted') ? (target.includes('breakpoint') ? 'debug-breakpoint' : 'debug-pause') : 'debug-start')];
    if (target.startsWith('halted')) {
      const resume = entry('Continue', 'Resume target (F5)', 'debug-continue');
      resume.command = { command: 'workbench.action.debug.continue', title: 'Continue' };
      result.push(resume);
    }
    result.push(entry('Probe', this.state.probeName ?? 'unknown', 'plug'), entry('Chip', this.state.chip ?? 'unknown', 'circuit-board'), entry('Program generation', String(this.state.programGeneration), 'versions'), entry('Stream epoch', String(this.state.streamEpoch), 'pulse'), entry('Stop ID', String(this.state.stopId), 'debug-line-by-line'), entry('Dropped frames', String(this.state.droppedFrames), 'warning'));
    if (this.state.actualSamplesPerSecond) { result.push(entry('Actual sample rate', `${this.state.actualSamplesPerSecond.toFixed(1)} S/s`, 'dashboard')); }
    if (this.state.lastError) { result.push(entry('Last error', this.state.lastError, 'error')); }
    return result;
  }
}

export class PeripheralNode extends vscode.TreeItem {
  constructor(public readonly peripheral: SvdPeripheral) {
    super(peripheral.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `0x${peripheral.baseAddress.toString(16)} · ${peripheral.registers.length} registers`;
    this.tooltip = peripheral.description;
    this.iconPath = new vscode.ThemeIcon('circuit-board');
  }
}

export class RegisterNode extends vscode.TreeItem {
  constructor(public readonly register: SvdRegister, value?: bigint) {
    super(register.name, register.fields.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const address = `@ 0x${register.address.toString(16)}`;
    this.description = value === undefined ? address : `${formatRegisterValue(value, register.sizeBits)} · ${address}`;
    this.tooltip = [register.description, register.access ? `Access: ${register.access}` : undefined, register.resetValue === undefined ? undefined : `Reset: 0x${register.resetValue.toString(16)}`].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon('symbol-field');
    this.contextValue = isWritable(register.access) ? 'cortexKit.registerWritable' : 'cortexKit.registerReadOnly';
    this.command = { command: 'cortexKit.readRegister', title: 'Read register', arguments: [this] };
  }
}

class FieldNode extends vscode.TreeItem {
  constructor(field: SvdField, registerValue?: bigint) {
    super(field.name, vscode.TreeItemCollapsibleState.None);
    const high = field.bitOffset + field.bitWidth - 1;
    const bits = field.bitWidth === 1 ? `bit ${field.bitOffset}` : `bits ${high}:${field.bitOffset}`;
    const value = registerValue === undefined ? undefined : (registerValue >> BigInt(field.bitOffset)) & ((1n << BigInt(field.bitWidth)) - 1n);
    this.description = value === undefined ? bits : `${bits} = 0x${value.toString(16)}`;
    this.tooltip = [field.description, field.access ? `Access: ${field.access}` : undefined].filter(Boolean).join('\n');
    this.iconPath = new vscode.ThemeIcon('symbol-enum-member');
  }
}

type PeripheralItem = PeripheralNode | RegisterNode | FieldNode | vscode.TreeItem;

export class PeripheralsProvider implements vscode.TreeDataProvider<PeripheralItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree?: SvdTree;
  private message = 'No SVD selected';
  private readonly registerValues = new Map<number, bigint>();
  private readonly trackedRegisters = new Map<number, SvdRegister>();
  load(tree?: SvdTree, source?: string): void {
    this.tree = tree;
    this.message = source ? `Could not load ${source}` : 'No SVD selected';
    this.registerValues.clear();
    this.trackedRegisters.clear();
    this.changed.fire();
  }
  setLoading(source: string): void { this.tree = undefined; this.message = `Loading ${source}…`; this.changed.fire(); }
  setError(message: string): void { this.tree = undefined; this.message = message; this.changed.fire(); }
  setRegisterValue(address: number, value: bigint): void {
    const register = this.tree?.peripherals.flatMap(peripheral => peripheral.registers).find(item => item.address === address);
    if (register) { this.trackedRegisters.set(address, register); }
    this.registerValues.set(address, value);
    this.changed.fire();
  }
  track(item: PeripheralNode | RegisterNode): SvdRegister[] {
    const registers = item instanceof PeripheralNode ? item.peripheral.registers.filter(register => !/writeonly/i.test(register.access ?? '')) : [item.register];
    for (const register of registers) { this.trackedRegisters.set(register.address, register); }
    return registers;
  }
  getTrackedRegisters(limit = 128): SvdRegister[] { return [...this.trackedRegisters.values()].slice(0, limit); }
  setRegisterValues(values: Array<{ address: number; value: number }>): void {
    for (const item of values) { this.registerValues.set(item.address, BigInt(Math.trunc(item.value))); }
    this.changed.fire();
  }
  clearValues(): void { if (this.registerValues.size) { this.registerValues.clear(); this.changed.fire(); } }
  get peripheralCount(): number { return this.tree?.peripherals.length ?? 0; }
  get deviceName(): string | undefined { return this.tree?.deviceName; }
  refresh(): void { this.changed.fire(); }
  getTreeItem(item: PeripheralItem): vscode.TreeItem { return item; }
  getChildren(parent?: PeripheralItem): PeripheralItem[] {
    if (parent instanceof PeripheralNode) { return parent.peripheral.registers.map(register => new RegisterNode(register, this.registerValues.get(register.address))); }
    if (parent instanceof RegisterNode) { return parent.register.fields.map(field => new FieldNode(field, this.registerValues.get(parent.register.address))); }
    if (!parent) { return this.tree?.peripherals.map(peripheral => new PeripheralNode(peripheral)) ?? [svdMessage(this.message)]; }
    return [];
  }
}

function entry(label: string, description: string, icon: string): vscode.TreeItem { const item = new vscode.TreeItem(label); item.description = description; item.tooltip = `${label}: ${description}`; item.iconPath = new vscode.ThemeIcon(icon); return item; }
function flatten(variables: VariableDescriptor[]): VariableDescriptor[] { return variables.flatMap(variable => [variable, ...flatten(variable.children)]); }
function formatVariableValue(value: number, variable: VariableDescriptor): string {
  if (!Number.isFinite(value)) { return String(value); }
  if (variable.scalarKind === 'boolean') { return value === 0 ? 'false' : 'true'; }
  if (variable.scalarKind === 'float32' || variable.scalarKind === 'float64') { return Number(value.toPrecision(8)).toString(); }
  if (variable.scalarKind === 'unsigned') { return `0x${Math.max(0, Math.trunc(value)).toString(16)}`; }
  return Math.trunc(value).toString();
}
function formatRegisterValue(value: bigint, sizeBits: number): string { return `0x${value.toString(16).padStart(Math.max(1, Math.ceil(sizeBits / 4)), '0')}`; }
function isWritable(access?: string): boolean { return access === undefined || /write/i.test(access); }
function liveWatchDetails(variable: VariableDescriptor, current?: LiveWatchValue): vscode.TreeItem[] {
  const value = current?.displayValue ?? (current ? formatLiveWatchValue(current.value, variable.scalarKind) : '<unavailable>');
  const updated = current?.timestampNs === undefined ? '<unavailable>' : `${(current.timestampNs / 1e9).toFixed(6)} s (target stream)`;
  const rate = current?.actualSamplesPerSecond ? `${current.actualSamplesPerSecond.toFixed(1)} S/s` : current?.source === 'snapshot' ? 'Direct read' : '<unavailable>';
  return [
    entry('Value', value, 'symbol-number'),
    entry('Type', variable.typeName, 'symbol-type-parameter'),
    entry('Expression', variable.expression, 'symbol-variable'),
    entry('Address', formatVariableAddress(variable) || '<dynamic>', 'symbol-key'),
    entry('Width', `${variable.byteWidth} byte${variable.byteWidth === 1 ? '' : 's'}`, 'symbol-ruler'),
    entry('Access', variable.writable ? 'read/write' : 'read-only', variable.writable ? 'edit' : 'lock'),
    entry('Update', updated, 'history'),
    entry('Sample rate', rate, 'dashboard'),
  ];
}
function liveWatchMessage(label: string): vscode.TreeItem { const item = new vscode.TreeItem(label); item.iconPath = new vscode.ThemeIcon('info'); return item; }
function formatVariableAddress(variable: VariableDescriptor, prefix = ''): string {
  if (variable.address !== undefined) { return `${prefix}0x${variable.address.toString(16)}`; }
  if (variable.pointerAddress !== undefined) {
    const offset = variable.pointerOffset ?? 0;
    return `${prefix}*(0x${variable.pointerAddress.toString(16)})${offset ? ` + 0x${offset.toString(16)}` : ''}`;
  }
  return '';
}
function svdMessage(label: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.iconPath = new vscode.ThemeIcon(label.startsWith('Loading') ? 'loading~spin' : 'file-code');
  if (label === 'No SVD selected') { item.command = { command: 'cortexKit.selectSvd', title: 'Select SVD file' }; }
  return item;
}
