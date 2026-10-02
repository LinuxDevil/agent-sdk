/**
 * Safe expression evaluator for flow conditions and `evaluator` nodes.
 *
 * Replaces the former `eval()` of `{{var}}`-interpolated strings. Expressions
 * are tokenized and parsed by a small hand-written recursive-descent parser
 * and then walked directly - no host code is ever compiled or executed.
 *
 * Supported grammar (see `docs/flows.md#flow-expressions`):
 *
 * - literals: `'str'`, `"str"`, `12`, `1.5`, `true`, `false`, `null`
 * - variables of the flow scope, with dot and bracket paths: `a.b[0]['c']`
 * - `.length` on strings and arrays
 * - comparison: `== === != !== < <= > >=`
 * - logical: `&& || !`, grouping with `( )`
 * - arithmetic: `+ - * / %` and unary `-` / `+`
 * - allow-listed methods: `.includes(x)` (string, array), `.startsWith(s)`,
 *   `.endsWith(s)` (string)
 *
 * Everything else (other calls, assignment, `constructor` / `__proto__` /
 * `prototype`, globals such as `process` or `globalThis`) is rejected with an
 * {@link ExpressionError}.
 *
 * @example
 * ```ts
 * evaluateSafeExpression("score >= 90 && tags.includes('vip')", { score: 95, tags: ['vip'] }); // true
 * ```
 */

/** Thrown for any expression that is malformed or uses unsupported syntax. */
export class ExpressionError extends Error {
  constructor(
    readonly expression: string,
    readonly position: number,
    reason: string
  ) {
    super(`Invalid expression "${expression}" at position ${position}: ${reason}. ${SUPPORTED_SUMMARY}`);
    this.name = 'ExpressionError';
  }
}

const SUPPORTED_SUMMARY =
  'Supported: string/number/boolean/null literals, variable and property paths (a.b, a["b"], a[0]), ' +
  '.length, comparison (== === != !== < <= > >=), logical (&& || !), arithmetic (+ - * / %), parentheses, ' +
  'and the methods .includes(), .startsWith(), .endsWith()';

type Scope = Record<string, unknown>;

interface Token {
  readonly kind: 'num' | 'str' | 'id' | 'op' | 'val' | 'eof';
  readonly value: string | number;
  readonly pos: number;
  /** The bound value of a bare `{{name}}` placeholder (kind `val` only). */
  readonly data?: unknown;
}

type Node =
  | { readonly t: 'lit'; readonly value: unknown }
  | { readonly t: 'id'; readonly name: string; readonly pos: number }
  | { readonly t: 'member'; readonly obj: Node; readonly key: Node; readonly pos: number }
  | { readonly t: 'call'; readonly callee: Node; readonly args: readonly Node[]; readonly pos: number }
  | { readonly t: 'unary'; readonly op: string; readonly arg: Node; readonly pos: number }
  | { readonly t: 'binary'; readonly op: string; readonly left: Node; readonly right: Node; readonly pos: number };

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['constructor', '__proto__', 'prototype']);
const LITERAL_KEYWORDS: Record<string, unknown> = { true: true, false: false, null: null };
const OPERATORS = [
  '===', '!==', '==', '!=', '<=', '>=', '&&', '||',
  '<', '>', '!', '(', ')', '[', ']', '.', ',', '+', '-', '*', '/', '%',
];
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };

const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '===': 3, '!=': 3, '!==': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

// ---------------------------------------------------------------- tokenizer

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

function readNumber(src: string, start: number): { token: Token; end: number } {
  let end = start;
  while (isDigit(src[end])) end++;
  if (src[end] === '.' && isDigit(src[end + 1])) {
    end++;
    while (isDigit(src[end])) end++;
  }
  return { token: { kind: 'num', value: Number(src.slice(start, end)), pos: start }, end };
}

const PLACEHOLDER = /\{\{(\w+)\}\}/y;

/** Match a `{{name}}` placeholder starting exactly at `start`. */
function matchPlaceholder(src: string, start: number): { name: string; end: number } | undefined {
  PLACEHOLDER.lastIndex = start;
  const match = PLACEHOLDER.exec(src);
  return match ? { name: match[1], end: start + match[0].length } : undefined;
}

/**
 * Text a placeholder contributes inside a string literal: the variable's
 * string form, or '' when it is missing or null (as the former text
 * substitution did).
 */
function placeholderText(name: string, scope: Scope): string {
  const value = Object.hasOwn(scope, name) ? scope[name] : undefined;
  return value === undefined || value === null ? '' : String(value);
}

/** One piece of a string literal: an interpolated placeholder, an escape, or a plain character. */
function readStringPiece(src: string, i: number, scope?: Scope): { text: string; end: number } {
  const placeholder = scope && src[i] === '{' ? matchPlaceholder(src, i) : undefined;
  if (placeholder && scope) return { text: placeholderText(placeholder.name, scope), end: placeholder.end };
  if (src[i] !== '\\') return { text: src[i], end: i + 1 };
  const escaped = ESCAPES[src[i + 1] ?? ''];
  if (escaped === undefined) throw new ExpressionError(src, i + 1, 'unsupported escape sequence in string');
  return { text: escaped, end: i + 2 };
}

function readString(src: string, start: number, scope?: Scope): { token: Token; end: number } {
  const quote = src[start];
  let out = '';
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    const piece = readStringPiece(src, i, scope);
    out += piece.text;
    i = piece.end;
  }
  if (i >= src.length) throw new ExpressionError(src, start, 'unterminated string literal');
  return { token: { kind: 'str', value: out, pos: start }, end: i + 1 };
}

function readOperator(src: string, start: number): Token {
  const op = OPERATORS.find((candidate) => src.startsWith(candidate, start));
  if (op) return { kind: 'op', value: op, pos: start };
  if (src[start] === '=') {
    throw new ExpressionError(src, start, 'assignment is not supported (use == or === to compare)');
  }
  throw new ExpressionError(src, start, `unexpected character '${src[start]}'`);
}

/**
 * Token for a bare `{{name}}`: the variable's value, bound as data. A missing
 * or null variable contributes no token (the old text substitution produced
 * an empty string there, so `{{x}} > 1` stays a syntax error).
 */
function readBoundPlaceholder(name: string, pos: number, scope: Scope): Token[] {
  const value = Object.hasOwn(scope, name) ? scope[name] : undefined;
  return value === undefined || value === null ? [] : [{ kind: 'val', value: '', pos, data: value }];
}

function readIdentifier(src: string, start: number): { token: Token; end: number } {
  let end = start + 1;
  while (isIdentPart(src[end])) end++;
  return { token: { kind: 'id', value: src.slice(start, end), pos: start }, end };
}

interface Read {
  tokens: Token[];
  end: number;
}

/** Read whatever token starts at `i` (none, for whitespace and missing placeholders). */
function readNext(src: string, i: number, scope?: Scope): Read {
  const ch = src[i];
  const placeholder = scope && ch === '{' ? matchPlaceholder(src, i) : undefined;
  if (placeholder && scope) return { tokens: readBoundPlaceholder(placeholder.name, i, scope), end: placeholder.end };
  if (/\s/.test(ch)) return { tokens: [], end: i + 1 };
  let read: { token: Token; end: number };
  if (isDigit(ch)) read = readNumber(src, i);
  else if (ch === "'" || ch === '"') read = readString(src, i, scope);
  else if (isIdentStart(ch)) read = readIdentifier(src, i);
  else {
    const token = readOperator(src, i);
    read = { token, end: i + String(token.value).length };
  }
  return { tokens: [read.token], end: read.end };
}

function tokenize(src: string, scope?: Scope): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const read = readNext(src, i, scope);
    tokens.push(...read.tokens);
    i = read.end;
  }
  tokens.push({ kind: 'eof', value: '', pos: src.length });
  return tokens;
}

// ------------------------------------------------------------------- parser

class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: Token[]
  ) {}

  parse(): Node {
    const node = this.parseBinary(1);
    const next = this.peek();
    if (next.kind !== 'eof') this.fail(next, `unexpected '${String(next.value)}'`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private fail(token: Token, reason: string): never {
    throw new ExpressionError(this.src, token.pos, reason);
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.value === value;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) this.fail(this.peek(), `expected '${value}'`);
    this.index++;
  }

  private enter(token: Token): void {
    if (++this.depth > MAX_DEPTH) this.fail(token, 'expression is nested too deeply');
  }

  private parseBinary(minPrecedence: number): Node {
    this.enter(this.peek());
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      const precedence = token.kind === 'op' ? PRECEDENCE[token.value as string] : undefined;
      if (precedence === undefined || precedence < minPrecedence) break;
      this.index++;
      const right = this.parseBinary(precedence + 1);
      left = { t: 'binary', op: token.value as string, left, right, pos: token.pos };
    }
    this.depth--;
    return left;
  }

  private parseUnary(): Node {
    const token = this.peek();
    if (token.kind === 'op' && (token.value === '!' || token.value === '-' || token.value === '+')) {
      this.index++;
      this.enter(token);
      const arg = this.parseUnary();
      this.depth--;
      return { t: 'unary', op: token.value, arg, pos: token.pos };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op') return node;
      if (token.value === '.') {
        this.index++;
        node = this.parseDotKey(node, token);
      } else if (token.value === '[') {
        this.index++;
        const key = this.parseBinary(1);
        this.expectOp(']');
        node = { t: 'member', obj: node, key, pos: token.pos };
      } else if (token.value === '(') {
        this.index++;
        node = { t: 'call', callee: node, args: this.parseArguments(), pos: token.pos };
      } else {
        return node;
      }
    }
  }

  private parseDotKey(obj: Node, dot: Token): Node {
    const name = this.next();
    if (name.kind !== 'id') this.fail(name, 'expected a property name after "."');
    return { t: 'member', obj, key: { t: 'lit', value: name.value }, pos: dot.pos };
  }

  private parseArguments(): Node[] {
    const args: Node[] = [];
    if (this.isOp(')')) {
      this.index++;
      return args;
    }
    for (;;) {
      args.push(this.parseBinary(1));
      if (this.isOp(',')) {
        this.index++;
      } else {
        break;
      }
    }
    this.expectOp(')');
    return args;
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (token.kind === 'num' || token.kind === 'str') return { t: 'lit', value: token.value };
    if (token.kind === 'val') return { t: 'lit', value: token.data };
    if (token.kind === 'id') {
      const name = token.value as string;
      if (Object.hasOwn(LITERAL_KEYWORDS, name)) return { t: 'lit', value: LITERAL_KEYWORDS[name] };
      return { t: 'id', name, pos: token.pos };
    }
    if (token.kind === 'op' && token.value === '(') {
      const inner = this.parseBinary(1);
      this.expectOp(')');
      return inner;
    }
    return this.fail(token, token.kind === 'eof' ? 'unexpected end of expression' : `unexpected '${String(token.value)}'`);
  }
}

// ---------------------------------------------------------------- evaluator

type Primitive = string | number | boolean | null | undefined;

function isPrimitive(value: unknown): value is Primitive {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

// Operands are runtime primitives (checked by requirePrimitive); typed as number for the operators.
const BINARY_OPS: Record<string, (a: number, b: number) => unknown> = {
  '==': (a, b) => a == b,
  '===': (a, b) => a === b,
  '!=': (a, b) => a != b,
  '!==': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

const STRING_METHODS = new Set(['includes', 'startsWith', 'endsWith']);

class Evaluator {
  constructor(
    private readonly src: string,
    private readonly scope: Scope
  ) {}

  private fail(pos: number, reason: string): never {
    throw new ExpressionError(this.src, pos, reason);
  }

  eval(node: Node): unknown {
    switch (node.t) {
      case 'lit':
        return node.value;
      case 'id':
        return this.lookup(node.name, node.pos);
      case 'member':
        return this.readMember(node);
      case 'call':
        return this.callMethod(node);
      case 'unary':
        return this.evalUnary(node);
      case 'binary':
        return this.evalBinary(node);
    }
  }

  private lookup(name: string, pos: number): unknown {
    if (FORBIDDEN_KEYS.has(name) || !Object.hasOwn(this.scope, name)) {
      this.fail(pos, `unknown variable '${name}' (only the flow's variables are available; no globals)`);
    }
    return this.scope[name];
  }

  private evalUnary(node: Extract<Node, { t: 'unary' }>): unknown {
    const value = this.eval(node.arg);
    if (node.op === '!') return !value;
    this.requirePrimitive(value, node.pos);
    return node.op === '-' ? -(value as number) : +(value as number);
  }

  private evalBinary(node: Extract<Node, { t: 'binary' }>): unknown {
    if (node.op === '&&' || node.op === '||') {
      const left = this.eval(node.left);
      if (node.op === '&&') return left ? this.eval(node.right) : left;
      return left ? left : this.eval(node.right);
    }
    const left = this.eval(node.left);
    const right = this.eval(node.right);
    if (node.op !== '===' && node.op !== '!==') {
      this.requirePrimitive(left, node.pos);
      this.requirePrimitive(right, node.pos);
    }
    return BINARY_OPS[node.op](left as number, right as number);
  }

  private requirePrimitive(value: unknown, pos: number): void {
    if (!isPrimitive(value)) this.fail(pos, 'operators other than === and !== only apply to strings, numbers, booleans and null');
  }

  private readMember(node: Extract<Node, { t: 'member' }>): unknown {
    return this.getProperty(this.eval(node.obj), this.eval(node.key), node.pos);
  }

  private getProperty(target: unknown, key: unknown, pos: number): unknown {
    if (typeof key !== 'string' && typeof key !== 'number') this.fail(pos, 'property keys must be strings or numbers');
    const name = String(key);
    if (FORBIDDEN_KEYS.has(name)) this.fail(pos, `access to '${name}' is not allowed`);
    if (target === null || target === undefined) this.fail(pos, `cannot read '${name}' of ${String(target)}`);
    if (typeof target === 'string') return this.stringProperty(target, name, pos);
    if (typeof target !== 'object') this.fail(pos, `cannot read '${name}' of a ${typeof target}`);
    return Object.hasOwn(target, name) ? (target as Record<string, unknown>)[name] : undefined;
  }

  private stringProperty(target: string, name: string, pos: number): unknown {
    if (name === 'length') return target.length;
    if (/^\d+$/.test(name)) return target[Number(name)];
    return this.fail(pos, `property '${name}' is not available on strings (only .length and indexes)`);
  }

  private callMethod(node: Extract<Node, { t: 'call' }>): unknown {
    const callee = node.callee;
    if (callee.t !== 'member') this.fail(node.pos, 'function calls are not supported');
    const target = this.eval(callee.obj);
    const name = this.eval(callee.key);
    if (typeof name !== 'string' || !STRING_METHODS.has(name)) {
      this.fail(callee.pos, `method '${String(name)}' is not allowed (allowed: includes, startsWith, endsWith)`);
    }
    const args = node.args.map((arg) => this.eval(arg));
    return this.applyMethod(target, name, args, node.pos);
  }

  private applyMethod(target: unknown, name: string, args: unknown[], pos: number): unknown {
    if (args.length !== 1) this.fail(pos, `.${name}() takes exactly one argument`);
    const [arg] = args;
    if (Array.isArray(target) && name === 'includes') return target.includes(arg);
    if (typeof target !== 'string') this.fail(pos, `.${name}() only applies to strings${name === 'includes' ? ' and arrays' : ''}`);
    if (typeof arg !== 'string') this.fail(pos, `.${name}() on a string needs a string argument`);
    if (name === 'includes') return target.includes(arg);
    return name === 'startsWith' ? target.startsWith(arg) : target.endsWith(arg);
  }
}

/** Options for {@link evaluateSafeExpression}. */
export interface EvaluateOptions {
  /**
   * Bind `{{name}}` placeholders from the scope as values. Bare, `{{score}}`
   * is the variable's value; inside a string literal, `'{{name}}'`
   * interpolates the value's string form into that literal. Values are never
   * re-parsed, so quotes, backslashes or operators in them stay data.
   * Missing and null variables read as an empty string inside a literal and
   * as nothing when bare.
   */
  readonly bindPlaceholders?: boolean;
}

/**
 * Evaluate an expression string against a variable scope without executing
 * any host code. An empty expression evaluates to `undefined`.
 *
 * @throws {ExpressionError} on malformed or unsupported syntax.
 */
export function evaluateSafeExpression(
  expression: string,
  scope: Scope,
  options: EvaluateOptions = {}
): unknown {
  const tokens = tokenize(expression, options.bindPlaceholders ? scope : undefined);
  if (tokens.length === 1) return undefined; // only the eof token: empty expression
  const ast = new Parser(expression, tokens).parse();
  return new Evaluator(expression, scope).eval(ast);
}
