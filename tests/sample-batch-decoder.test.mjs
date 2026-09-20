import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchDecoder, decodePayload } from './sample-batch-decoder.mjs';

function payload() {
  const strings = ['session-1', 'a', 'b'].map(value => {
    const bytes = Buffer.from(value);
    const encoded = Buffer.alloc(2 + bytes.length);
    encoded.writeUInt16LE(bytes.length);
    bytes.copy(encoded, 2);
    return encoded;
  });
  const fixed = Buffer.alloc(6 + strings[0].length + 54);
  fixed.write('CKIT', 0, 'ascii');
  fixed.writeUInt16LE(1, 4);
  let offset = 6;
  strings[0].copy(fixed, offset); offset += strings[0].length;
  fixed.writeBigUInt64LE(2n, offset); offset += 8;
  fixed.writeBigUInt64LE(3n, offset); offset += 8;
  fixed.writeBigUInt64LE(4n, offset); offset += 8;
  fixed.writeUInt32LE(1, offset); offset += 4;
  fixed.writeBigUInt64LE(5n, offset); offset += 8;
  fixed.writeBigUInt64LE(6n, offset); offset += 8;
  fixed.writeBigUInt64LE(7n, offset); offset += 8;
  fixed.writeUInt16LE(2, offset);
  const values = Buffer.alloc(16);
  values.writeDoubleLE(1.25, 0);
  values.writeDoubleLE(-2.5, 8);
  return Buffer.concat([fixed, strings[1], strings[2], values]);
}

test('decodes fragmented CKIT batches without production TypeScript', () => {
  const body = payload();
  const framed = Buffer.alloc(4 + body.length);
  framed.writeUInt32LE(body.length);
  body.copy(framed, 4);
  const decoder = new BatchDecoder();
  assert.deepEqual(decoder.push(framed.subarray(0, 9)), []);
  const [batch] = decoder.push(framed.subarray(9));
  assert.deepEqual(batch.channelIds, ['a', 'b']);
  assert.deepEqual(batch.values, [1.25, -2.5]);
  assert.equal(batch.batchSequence, 4);
});

test('rejects truncated and trailing payload bytes', () => {
  const body = payload();
  assert.throws(() => decodePayload(body.subarray(0, -1)), /Truncated/);
  assert.throws(() => decodePayload(Buffer.concat([body, Buffer.from([0])])), /Trailing/);
});
