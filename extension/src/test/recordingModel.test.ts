import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCurves, csvHeader, csvRows, defaultTimeColumn, FrameSampler, parseCsv, reducePoints, timeScale } from '../recordingModel';
import { SampleBatch } from '../types';

function batch(start: number, count: number, period = 1_000_000, epoch = 1): SampleBatch {
  return { sessionId: 's', programGeneration: 1, streamEpoch: epoch, batchSequence: 1,
    channelIds: ['a', 'b'], sampleCount: count, startTimestampNs: start, samplePeriodNs: period, droppedFrames: 0,
    values: Array.from({ length: count }, (_, i) => [start / period + i, -(start / period + i)]).flat() };
}
test('rate selection uses real frames across batch boundaries without fabricating samples', () => {
  const sampler = new FrameSampler(['b', 'a'], 100);
  const rows = [...sampler.accept(batch(0, 15)), ...sampler.accept(batch(15_000_000, 15))];
  assert.deepEqual(rows.map(row => row.timestampNs), [0, 10_000_000, 20_000_000]);
  assert.deepEqual(rows[1].values, [-10, 10]);
  assert.equal(sampler.actualHz, 100);
  const slow = new FrameSampler(['a'], 1000);
  assert.equal(slow.accept(batch(0, 5, 5_000_000)).length, 5);
  assert.equal(slow.actualHz, 200);
});
test('pause and resume preserve source timestamp gaps and epoch in CSV, other groups are ignored', () => {
  const sampler = new FrameSampler(['a'], 1000);
  assert.deepEqual(sampler.accept({ ...batch(0, 1), channelIds: ['c', 'd'] }), []);
  const rows = [...sampler.accept(batch(100_000_000, 2)), ...sampler.accept(batch(2_100_000_000, 2, 1_000_000, 2))];
  assert.equal(rows[2].elapsedSeconds, 2);
  const parsed = parseCsv(csvHeader(['a']) + csvRows(rows));
  assert.deepEqual(parsed.headers, ['elapsed_s', 'timestamp_ns', 'stream_epoch', 'a']);
  assert.equal(parsed.rows[2][1], 2_100_000_000);
  const curve = csvCurves(parsed, 0, 1, [3])[0];
  assert.deepEqual(curve.points[2], [2, null]);
  assert.equal(curve.points[3][1], rows[2].values[0]);
  assert.throws(() => sampler.accept({ ...batch(0, 1), sessionId: 'new' }), /会话/);
});
test('replayed batches do not duplicate CSV rows; malformed batch/rate inputs fail', () => {
  const sampler = new FrameSampler(['a'], 1000);
  assert.equal(sampler.accept(batch(0, 5)).length, 5);
  assert.equal(sampler.accept(batch(0, 5)).length, 0);
  assert.throws(() => sampler.accept({ ...batch(5_000_000, 2), values: [] }), /长度/);
  for (const rate of [0, -1, NaN, 1.5, 100001]) { assert.throws(() => new FrameSampler(['a'], rate), /频率/); }
});
test('CSV handles BOM, quotes, commas, CRLF, missing values and reserved names', () => {
  const text = csvHeader(['array,member', 'quoted"name', 'timestamp_ns']) + csvRows([
    { elapsedSeconds: 0, timestampNs: 123, streamEpoch: 1, values: [1, NaN, 3] },
  ]);
  const table = parseCsv(text);
  assert.deepEqual(table.headers.slice(3), ['array,member', 'quoted"name', 'timestamp_ns (2)']);
  assert.equal(table.rows[0][4], null);
  assert.deepEqual(parseCsv('t,a\n0,\n1,4\n').rows, [[0, null], [1, 4]]);
});
test('CSV rejects malformed rows and ambiguous headers with useful errors', () => {
  for (const text of ['t,a\n0,1,2', 't,t\n0,1', 't,"a\n0,1', 't,a\n0,"1"x', 't,a\n']) {
    assert.throws(() => parseCsv(text), /CSV/);
  }
  assert.throws(() => csvCurves(parseCsv('t,a\n1,2\n0,3'), 0, 1, [1]), /倒退/);
});
test('numeric timestamps have selectable units and selected channels keep names and values', () => {
  const table = parseCsv('timestamp_ns,position,velocity\n1000000000,4,5\n1500000000,6,7');
  const column = defaultTimeColumn(table.headers);
  const curves = csvCurves(table, column, timeScale(table.headers[column]), [2]);
  assert.equal(curves[0].name, 'velocity');
  assert.deepEqual(curves[0].points, [[0, 5], [.5, 7]]);
});
test('curve reduction preserves spikes and zoom requests recover source detail', () => {
  const points: Array<[number, number | null]> = Array.from({ length: 10000 }, (_, i) => [i, i === 3456 ? 999 : i === 7001 ? null : 0]);
  const reduced = reducePoints(points, 200);
  assert.ok(reduced.length <= 200);
  assert.ok(reduced.some(point => point[1] === 999));
  assert.ok(reduced.some(point => point[1] === null));
  assert.deepEqual(reduced[0], points[0]);
  assert.deepEqual(reduced.at(-1), points.at(-1));
  const table = { headers: ['time', 'v'], rows: points };
  const zoom = csvCurves(table, 0, 1, [1], [3450, 3460])[0];
  assert.equal(zoom.points.length, 13);
  assert.ok(zoom.points.some(point => point[1] === 999));
});
