import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchDecoder } from '../binaryProtocol';

test('decoder handles split length-prefixed frames', () => {
  const strings = [Buffer.from('session'), Buffer.from('signal')];
  const payload = Buffer.alloc(4 + 2 + 2 + strings[0].length + 8 * 3 + 4 + 8 * 3 + 2 + 2 + strings[1].length + 8);
  let o = 0; payload.write('CKIT', o); o += 4; payload.writeUInt16LE(1, o); o += 2;
  payload.writeUInt16LE(strings[0].length, o); o += 2; strings[0].copy(payload, o); o += strings[0].length;
  for (const value of [1n, 2n, 3n]) { payload.writeBigUInt64LE(value, o); o += 8; }
  payload.writeUInt32LE(1, o); o += 4;
  for (const value of [100n, 1000n, 0n]) { payload.writeBigUInt64LE(value, o); o += 8; }
  payload.writeUInt16LE(1, o); o += 2; payload.writeUInt16LE(strings[1].length, o); o += 2; strings[1].copy(payload, o); o += strings[1].length; payload.writeDoubleLE(1.25, o);
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  const decoder = new BatchDecoder();
  assert.equal(decoder.push(frame.subarray(0, 7)).length, 0);
  const [batch] = decoder.push(frame.subarray(7));
  assert.deepEqual(batch.channelIds, ['signal']); assert.deepEqual(batch.values, [1.25]); assert.equal(batch.streamEpoch, 2);
});
