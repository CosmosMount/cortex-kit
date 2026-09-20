export class BatchDecoder {
  pending = Buffer.alloc(0);

  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const batches = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (this.pending.length < 4 + length) break;
      batches.push(decodePayload(this.pending.subarray(4, 4 + length)));
      this.pending = this.pending.subarray(4 + length);
    }
    return batches;
  }
}

export function decodePayload(payload) {
  let offset = 0;
  const requireBytes = count => {
    if (offset + count > payload.length) throw new Error('Truncated Cortex Kit sample frame');
  };
  const readString = () => {
    requireBytes(2);
    const length = payload.readUInt16LE(offset);
    offset += 2;
    requireBytes(length);
    const value = payload.subarray(offset, offset + length).toString('utf8');
    offset += length;
    return value;
  };

  requireBytes(6);
  const magic = payload.subarray(offset, offset + 4).toString('ascii');
  offset += 4;
  if (magic !== 'CKIT') throw new Error('Invalid Cortex Kit sample frame');
  const version = payload.readUInt16LE(offset);
  offset += 2;
  if (version !== 1) throw new Error(`Unsupported sample protocol ${version}`);

  const sessionId = readString();
  requireBytes(54);
  const programGeneration = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const streamEpoch = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const batchSequence = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const sampleCount = payload.readUInt32LE(offset); offset += 4;
  const startTimestampNs = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const samplePeriodNs = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const droppedFrames = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const channelCount = payload.readUInt16LE(offset); offset += 2;
  const channelIds = Array.from({ length: channelCount }, readString);
  const valueCount = sampleCount * channelCount;
  if (!Number.isSafeInteger(valueCount)) throw new Error('Invalid Cortex Kit sample dimensions');
  requireBytes(valueCount * 8);
  const values = new Array(valueCount);
  for (let index = 0; index < valueCount; index += 1) {
    values[index] = payload.readDoubleLE(offset);
    offset += 8;
  }
  if (offset !== payload.length) throw new Error('Trailing bytes in Cortex Kit sample frame');
  return { sessionId, programGeneration, streamEpoch, batchSequence, sampleCount, startTimestampNs, samplePeriodNs, droppedFrames, channelIds, values };
}
