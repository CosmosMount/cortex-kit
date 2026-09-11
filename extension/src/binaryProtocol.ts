import { SampleBatch } from './types';

export class BatchDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): SampleBatch[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const batches: SampleBatch[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (this.pending.length < 4 + length) { break; }
      batches.push(decodePayload(this.pending.subarray(4, 4 + length)));
      this.pending = this.pending.subarray(4 + length);
    }
    return batches;
  }
}
export function decodePayload(payload: Buffer): SampleBatch {
  let offset = 0;
  const expect = payload.subarray(0, 4).toString('ascii'); offset += 4;
  if (expect !== 'CKIT') { throw new Error('Invalid Cortex Kit sample frame'); }
  const version = payload.readUInt16LE(offset); offset += 2;
  if (version !== 1) { throw new Error(`Unsupported sample protocol ${version}`); }
  const readString = () => { const length = payload.readUInt16LE(offset); offset += 2; const value = payload.subarray(offset, offset + length).toString('utf8'); offset += length; return value; };
  const sessionId = readString();
  const programGeneration = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const streamEpoch = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const batchSequence = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const sampleCount = payload.readUInt32LE(offset); offset += 4;
  const startTimestampNs = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const samplePeriodNs = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const droppedFrames = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const channelCount = payload.readUInt16LE(offset); offset += 2;
  const channelIds = Array.from({ length: channelCount }, readString);
  const values = new Array<number>(sampleCount * channelCount);
  for (let index = 0; index < values.length; index += 1) { values[index] = payload.readDoubleLE(offset); offset += 8; }
  return { sessionId, programGeneration, streamEpoch, batchSequence, sampleCount, startTimestampNs, samplePeriodNs, droppedFrames, channelIds, values };
}
