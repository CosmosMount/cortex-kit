type Token = { kind: 'number'; value: number } | { kind: 'identifier'; value: string } | { kind: 'operator'; value: string } | { kind: 'left' } | { kind: 'right' };

export function expressionDependencies(source: string): string[] { return [...new Set(tokenize(source).filter((token): token is Extract<Token, { kind: 'identifier' }> => token.kind === 'identifier').map(token => token.value))]; }

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
