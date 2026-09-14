import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateExpression, expressionDependencies } from '../expression';

test('evaluates plotted expressions and dependencies', () => {
  const values = new Map([['motor.iq', 3], ['samples[2]', 4]]);
  assert.equal(evaluateExpression('motor.iq * 2 + samples[2]', values), 10);
  assert.deepEqual(expressionDependencies('motor.iq * 2 + samples[2]'), ['motor.iq', 'samples[2]']);
  assert.equal(evaluateExpression('motor.iq >= 3', values), 1);
});

test('pointer-member expressions remain valid Plot dependencies', () => {
  const name = 'robot::motor_pointer->samples[1].value';
  const values = new Map([[name, 2.5]]);
  assert.equal(evaluateExpression(`${name} * 2`, values), 5);
  assert.deepEqual(expressionDependencies(`${name} * 2`), [name]);
});
