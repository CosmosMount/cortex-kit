type Token = { kind: 'number'; value: number } | { kind: 'identifier'; value: string } | { kind: 'operator'; value: string } | { kind: 'left' } | { kind: 'right' };

const precedence: Record<string, number> = { '|': 1, '^': 2, '&': 3, '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, '<<': 5, '>>': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, 'u+': 8, 'u-': 8, '~': 8 };
const rightAssociative = new Set(['u+', 'u-', '~']);

export function expressionDependencies(source: string): string[] { return [...new Set(tokenize(source).filter((token): token is Extract<Token, { kind: 'identifier' }> => token.kind === 'identifier').map(token => token.value))]; }

export function evaluateExpression(source: string, values: ReadonlyMap<string, number>): number {
  const output: Token[] = []; const operators: Token[] = []; let expectsValue = true;
  for (const token of tokenize(source)) {
    if (token.kind === 'number' || token.kind === 'identifier') { output.push(token); expectsValue = false; continue; }
    if (token.kind === 'left') { operators.push(token); expectsValue = true; continue; }
    if (token.kind === 'right') { while (operators.length && operators.at(-1)?.kind !== 'left') { output.push(operators.pop()!); } if (operators.pop()?.kind !== 'left') { throw new Error('Missing opening parenthesis'); } expectsValue = false; continue; }
    let operator = token.value; if (expectsValue && (operator === '+' || operator === '-')) { operator = `u${operator}`; }
    const normalized: Token = { kind: 'operator', value: operator };
    while (operators.at(-1)?.kind === 'operator') { const top = (operators.at(-1) as Extract<Token, { kind: 'operator' }>).value; if (precedence[top] > precedence[operator] || (precedence[top] === precedence[operator] && !rightAssociative.has(operator))) { output.push(operators.pop()!); } else { break; } }
    operators.push(normalized); expectsValue = true;
  }
  while (operators.length) { const token = operators.pop()!; if (token.kind === 'left') { throw new Error('Missing closing parenthesis'); } output.push(token); }
  const stack: number[] = [];
  for (const token of output) {
    if (token.kind === 'number') { stack.push(token.value); continue; }
    if (token.kind === 'identifier') { const value = values.get(token.value); if (value === undefined) { throw new Error(`Unknown variable: ${token.value}`); } stack.push(value); continue; }
    if (token.kind !== 'operator') { throw new Error('Invalid expression'); }
    if (rightAssociative.has(token.value)) { const value = requireValue(stack); stack.push(token.value === 'u-' ? -value : token.value === '~' ? ~Math.trunc(value) : value); continue; }
    const right = requireValue(stack); const left = requireValue(stack); stack.push(binary(token.value, left, right));
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) { throw new Error('Invalid expression result'); }
  return stack[0];
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    const rest = source.slice(index); const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest);
    if (number) { tokens.push({ kind: 'number', value: Number(number[0]) }); index += number[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|->|\.)[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*/.exec(rest);
    if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0] }); index += identifier[0].length; continue; }
    if (source[index] === '(') { tokens.push({ kind: 'left' }); index += 1; continue; }
    if (source[index] === ')') { tokens.push({ kind: 'right' }); index += 1; continue; }
    const compound = ['<<', '>>', '<=', '>=', '==', '!='].find(value => rest.startsWith(value));
    const operator = compound ?? ('+-*/%&|^~<>'.includes(source[index]) ? source[index] : undefined);
    if (operator) { tokens.push({ kind: 'operator', value: operator }); index += operator.length; continue; }
    throw new Error(`Unexpected token at ${index}`);
  }
  return tokens;
}

function requireValue(stack: number[]): number { const value = stack.pop(); if (value === undefined) { throw new Error('Missing operand'); } return value; }
function binary(operator: string, left: number, right: number): number {
  switch (operator) {
    case '+': return left + right; case '-': return left - right; case '*': return left * right;
    case '/': if (right === 0) throw new Error('Division by zero'); return left / right;
    case '%': if (right === 0) throw new Error('Division by zero'); return left % right;
    case '<<': return Math.trunc(left) << Math.trunc(right); case '>>': return Math.trunc(left) >> Math.trunc(right);
    case '&': return Math.trunc(left) & Math.trunc(right); case '|': return Math.trunc(left) | Math.trunc(right); case '^': return Math.trunc(left) ^ Math.trunc(right);
    case '<': return Number(left < right); case '<=': return Number(left <= right); case '>': return Number(left > right); case '>=': return Number(left >= right); case '==': return Number(left === right); case '!=': return Number(left !== right);
    default: throw new Error(`Unsupported operator: ${operator}`);
  }
}
