import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLiveWatchValue,
  latestLiveWatchValues,
  mergeSubscriptionIds,
  selectBatchChannels,
  splitSubscriptions,
  validateLiveWatchInput,
} from '../liveWatchModel';
import { SampleBatch } from '../types';

const batch: SampleBatch = {
  sessionId: 'session', programGeneration: 1, streamEpoch: 2, batchSequence: 3,
  sampleCount: 2, startTimestampNs: 1_000, samplePeriodNs: 100, droppedFrames: 0,
  channelIds: ['plot-only', 'shared', 'watch-only'],
  values: [1, 2, 3, 4, 5, 6],
};

test('Plot subscriptions keep watch-only channels slow and reuse shared channels', () => {
  assert.deepEqual(splitSubscriptions(['plot', 'shared'], ['shared', 'watch', 'watch'], 1000, 20), {
    ids: ['plot', 'shared'], requestedSamplesPerSecond: 1000,
    backgroundIds: ['watch'], backgroundSamplesPerSecond: 20,
  });
  assert.deepEqual(splitSubscriptions([], ['watch'], 1000, 20), {
    ids: ['watch'], requestedSamplesPerSecond: 20,
    backgroundIds: [], backgroundSamplesPerSecond: 20,
  });
  assert.deepEqual(splitSubscriptions([], [], 1000, 20).ids, []);
});

test('Live Watch and Plot keep separate displays while sharing one deduplicated hardware subscription', () => {
  assert.deepEqual(mergeSubscriptionIds(['plot-only', 'shared'], ['shared', 'watch-only']), ['plot-only', 'shared', 'watch-only']);
  const plotted = selectBatchChannels(batch, ['plot-only', 'shared']);
  assert.deepEqual(plotted.channelIds, ['plot-only', 'shared']);
  assert.deepEqual(plotted.values, [1, 2, 4, 5]);
  assert.deepEqual(latestLiveWatchValues(batch, ['watch-only']), [{
    id: 'watch-only', value: 6, timestampNs: 1_100, actualSamplesPerSecond: 10_000_000, source: 'stream',
  }]);
});

test('Live Watch validates typed edits and formats detailed values', () => {
  assert.equal(validateLiveWatchInput('0x2A', 'unsigned'), undefined);
  assert.equal(validateLiveWatchInput('-1', 'unsigned'), 'Unsigned variables cannot be negative');
  assert.equal(validateLiveWatchInput('true', 'boolean'), undefined);
  assert.equal(validateLiveWatchInput('nan', 'float32'), 'Enter a finite decimal number');
  assert.equal(formatLiveWatchValue(42, 'unsigned'), '42 (0x2A)');
  assert.equal(formatLiveWatchValue(-3, 'signed'), '-3');
});
