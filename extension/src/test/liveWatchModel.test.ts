import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLiveWatchValue,
  mergeSubscriptionIds,
  splitSubscriptions,
  validateLiveWatchInput,
} from '../liveWatchModel';

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

test('Live Watch and Plot share one deduplicated hardware subscription', () => {
  assert.deepEqual(mergeSubscriptionIds(['plot-only', 'shared'], ['shared', 'watch-only']), ['plot-only', 'shared', 'watch-only']);
});

test('Live Watch validates typed edits and formats detailed values', () => {
  assert.equal(validateLiveWatchInput('0x2A', 'unsigned'), undefined);
  assert.equal(validateLiveWatchInput('-1', 'unsigned'), 'Unsigned variables cannot be negative');
  assert.equal(validateLiveWatchInput('true', 'boolean'), undefined);
  assert.equal(validateLiveWatchInput('nan', 'float32'), 'Enter a finite decimal number');
  assert.equal(formatLiveWatchValue(42, 'unsigned'), '42 (0x2A)');
  assert.equal(formatLiveWatchValue(-3, 'signed'), '-3');
});
