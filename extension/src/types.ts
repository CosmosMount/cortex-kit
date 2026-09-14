export type ScalarKind = 'unsigned' | 'signed' | 'float32' | 'float64' | 'boolean';
export interface VariableDescriptor { id: string; name: string; expression: string; typeName: string; address?: number; pointerAddress?: number; pointerOffset?: number; byteWidth: number; scalarKind: ScalarKind; writable: boolean; children: VariableDescriptor[]; }
export interface SessionState { sessionId: string; programGeneration: number; streamEpoch: number; stopId: number; revision: number; targetState: string | { halted: { reason: string } }; probeName?: string; chip?: string; actualSamplesPerSecond: number; droppedFrames: number; lastError?: string; }
export interface SampleBatch { sessionId: string; programGeneration: number; streamEpoch: number; batchSequence: number; sampleCount: number; startTimestampNs: number; samplePeriodNs: number; droppedFrames: number; channelIds: string[]; values: number[]; }
export interface LiveWatchValue { id: string; value: number; timestampNs?: number; actualSamplesPerSecond?: number; source: 'stream' | 'snapshot' | 'write'; displayValue?: string; }
export type ChartMode = 'time' | 'fft' | 'both';
export interface ChartLayout { id: string; title: string; mode: ChartMode; variableIds: string[]; }
export type ChartArrangement = 'grid' | 'row' | 'column';

export interface SvdField {
  name: string;
  description?: string;
  bitOffset: number;
  bitWidth: number;
  access?: string;
}

export interface SvdRegister {
  name: string;
  description?: string;
  address: number;
  sizeBits: number;
  access?: string;
  resetValue?: number;
  fields: SvdField[];
}

export interface SvdPeripheral {
  name: string;
  description?: string;
  baseAddress: number;
  registers: SvdRegister[];
}

export interface SvdTree {
  deviceName: string;
  peripherals: SvdPeripheral[];
}
