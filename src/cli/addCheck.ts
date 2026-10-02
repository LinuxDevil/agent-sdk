/**
 * The install-time check of a registry item against its permission manifest
 * (M7a): before `lousho add` writes anything, every JavaScript / TypeScript file
 * of the item is scanned, comments stripped, for what it visibly reaches for
 * (commands, the filesystem, the network, environment variables) and compared
 * with what `permissions` declares. It is a check of the code as written, not a
 * sandbox: code that hides what it does (escapes, aliasing, encoded strings) can
 * get past it. `checkItem` is pure so a registry build can reuse it.
 */
import { matchesHost } from '../security/hostPattern';
import type { RegistryItem } from './registry';

export interface ManifestFinding {
  file: string;
  /** 1-based. */
  line: number;
  /** What the code does, e.g. `import of 'node:child_process'`. */
  what: string;
  /** How to fix it, e.g. `declare exec: true in permissions`. */
  fix: string;
  /** `refuse` blocks the install; `note` is printed and does not. */
  level: 'refuse' | 'note';
}

/** `<file>:<line>: <what> (<fix>)`. */
export function formatFinding(finding: ManifestFinding): string {
  return `${finding.file}:${finding.line}: ${finding.what} (${finding.fix})`;
}

/** Files the code rules apply to; anything else (Markdown, JSON, text) is not scanned. */
const isCodeFile = (file: string): boolean => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);

interface Literal {
  /** Index of the opening quote or backtick, or of the `}` that resumes a template. */
  open: number;
  /** Index of the first character of the text. */
  start: number;
  /** Index just after the closing quote / backtick, or after `${`. */
  end: number;
  /** The raw source text between the delimiters (escapes not decoded). */
  raw: string;
  /** True for a template segment that is followed by `${`. */
  interpolated: boolean;
}

interface Scanned {
  /** The source with comments blanked out (same length, newlines kept). */
  code: string;
  /** `code` with the text of strings, templates and regex literals blanked out too. */
  bare: string;
  literals: Literal[];
}

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD = /[A-Za-z0-9_$]+/y;

/** A small JS lexer (no parser dependency): blanks comments, and string / template / regex text in the bare view. */
class Lexer {
  private readonly n: number;
  private readonly code: string[];
  private readonly bare: string[];
  private readonly literals: Literal[] = [];
  /** The brace depth at which each open template's `${` started. */
  private readonly templates: number[] = [];
  private braces = 0;
  private lastChar = '';
  private lastWord = '';

  constructor(private readonly source: string) {
    this.n = source.length;
    this.code = source.split('');
    this.bare = source.split('');
  }

  run(): Scanned {
    let i = 0;
    while (i < this.n) i = this.comment(i) ?? this.string(i) ?? this.template(i) ?? this.regex(i) ?? this.word(i) ?? this.punctuation(i);
    return { code: this.code.join(''), bare: this.bare.join(''), literals: this.literals };
  }

  private blank(target: string[], from: number, to: number): void {
    for (let k = from; k < Math.min(to, this.n); k++) if (this.source[k] !== '\n' && this.source[k] !== '\r') target[k] = ' ';
  }

  /** Marks the end of a value-like token: a `/` after it is a division. */
  private afterValue(next: number, lastChar = 'a'): number {
    this.lastChar = lastChar;
    this.lastWord = '';
    return next;
  }

  private comment(i: number): number | undefined {
    const { source } = this;
    if (source[i] !== '/' || (source[i + 1] !== '/' && source[i + 1] !== '*')) return undefined;
    const line = source[i + 1] === '/';
    const close = line ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
    const end = close < 0 ? this.n : close + (line ? 0 : 2);
    this.blank(this.code, i, end);
    this.blank(this.bare, i, end);
    return end;
  }

  private string(open: number): number | undefined {
    const { source } = this;
    const quote = source[open];
    if (quote !== '"' && quote !== "'") return undefined;
    let j = open + 1;
    while (j < this.n && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    const close = Math.min(j, this.n);
    this.literals.push({ open, start: open + 1, end: close + 1, raw: source.slice(open + 1, close), interpolated: false });
    this.blank(this.bare, open + 1, close);
    return this.afterValue(close + 1);
  }

  /** A template start, or the `}` that ends a `${...}` and resumes its template. */
  private template(open: number): number | undefined {
    const c = this.source[open];
    const resumes = c === '}' && this.templates.length > 0 && this.templates[this.templates.length - 1] === this.braces;
    if (c !== '`' && !resumes) return undefined;
    if (resumes) this.templates.pop();
    const { end, interpolated } = this.templateText(open, open + 1);
    if (interpolated) this.templates.push(this.braces);
    return this.afterValue(end, interpolated ? '{' : 'a');
  }

  /** Reads template text from `from` up to a backtick or `${`. */
  private templateText(open: number, from: number): { end: number; interpolated: boolean } {
    const { source } = this;
    let j = from;
    while (j < this.n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
    const stop = Math.min(j, this.n);
    const interpolated = source[stop] === '$';
    const end = stop >= this.n ? this.n : stop + (interpolated ? 2 : 1);
    this.literals.push({ open, start: from, end, raw: source.slice(from, stop), interpolated });
    this.blank(this.bare, from, stop);
    return { end, interpolated };
  }

  private regex(i: number): number | undefined {
    if (this.source[i] !== '/') return undefined;
    const allowed = this.lastChar === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(this.lastChar) || REGEX_AFTER_WORD.has(this.lastWord);
    const end = allowed ? this.regexEnd(i) : -1;
    if (end < 0) return undefined;
    this.blank(this.bare, i + 1, end);
    return this.afterValue(end);
  }

  /** The end of a regex literal starting at `i` (flags included), or -1 when a line ends first. */
  private regexEnd(i: number): number {
    const { source } = this;
    let inClass = false;
    for (let j = i + 1; j < this.n && source[j] !== '\n'; j++) {
      const c = source[j];
      if (c === '\\') j++;
      else if (c === '[' || c === ']') inClass = c === '[';
      else if (c === '/' && !inClass) return j + 1 + (/^[a-z]*/i.exec(source.slice(j + 1, j + 20))?.[0].length ?? 0);
    }
    return -1;
  }

  private word(i: number): number | undefined {
    WORD.lastIndex = i;
    const word = WORD.exec(this.source);
    if (!word) return undefined;
    this.lastChar = 'a';
    this.lastWord = word[0];
    return i + word[0].length;
  }

  private punctuation(i: number): number {
    const c = this.source[i];
    if (c === '{') this.braces++;
    else if (c === '}') this.braces--;
    if (!/\s/.test(c)) this.afterValue(0, c === ')' || c === ']' ? 'a' : c);
    return i + (c === '\\' ? 2 : 1);
  }
}

/** Splits a source file into code, bare code and literals. */
export function scanSource(source: string): Scanned {
  return new Lexer(source).run();
}

const EXEC_MODULES = new Set(['child_process', 'execa', 'shelljs']);
const FS_MODULES = new Set(['fs', 'fs-extra', 'graceful-fs']);
const NET_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici', 'axios', 'node-fetch', 'ws']);
const EXEC_SDK = /(?<![\w$])(createShellTool|runShellCommand|SubprocessSandbox)(?![\w$])/g;
const FS_SDK = /(?<![\w$])createFsTools(?![\w$])/g;
const NET_SDK = /(?<![\w$])createHttpTool(?![\w$])/g;
const FS_WRITE_CALL =
  /(?<![\w$])(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync)\s*\(/g;
const STATIC_IMPORT = /(?<![\w$.])import\s+(type\s+)?(?:[\w$*{}\s,]+?\s*from\s*)?(?=['"])/g;
const STATIC_EXPORT = /(?<![\w$.])export\s+(type\s+)?[\w$*{}\s,]+?\s*from\s*(?=['"])/g;
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/([^\s'"`/?#\\]*)/gi;
const ENV_NAME = /^[A-Za-z_$][\w$]*$/;

/** `node:fs/promises` -> `fs`; `@scope/pkg/x` -> `@scope/pkg`. */
function moduleBase(specifier: string): string {
  const parts = specifier.replace(/^node:/, '').split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

class FileCheck {
  readonly findings: ManifestFinding[] = [];
  private readonly scanned: Scanned;
  private readonly literalAt = new Map<number, Literal>();
  private readonly lineStarts: number[] = [0];

  constructor(
    private readonly file: string,
    source: string,
    private readonly permissions: RegistryItem['permissions']
  ) {
    this.scanned = scanSource(source);
    for (const literal of this.scanned.literals) if (source[literal.open] !== '}') this.literalAt.set(literal.open, literal);
    for (let k = 0; k < source.length; k++) if (source[k] === '\n') this.lineStarts.push(k + 1);
  }

  private lineOf(offset: number): number {
    let line = 0;
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line++;
    return line + 1;
  }

  private add(offset: number, what: string, fix: string, level: ManifestFinding['level'] = 'refuse'): void {
    const finding = { file: this.file, line: this.lineOf(offset), what, fix, level };
    if (!this.findings.some((f) => formatFinding(f) === formatFinding(finding))) this.findings.push(finding);
  }

  private never(offset: number, what: string): void {
    this.add(offset, what, 'never allowed in a registry item');
  }

  /** The literal whose opening quote is the first non-space character at or after `from` in bare code, if it is a plain one. */
  private plainLiteralFrom(from: number): Literal | undefined {
    let k = from;
    while (k < this.scanned.bare.length && /\s/.test(this.scanned.bare[k])) k++;
    const literal = this.literalAt.get(k);
    return literal && !literal.interpolated ? literal : undefined;
  }

  /** The text after a literal's end, in bare code, without leading space. */
  private after(literal: Literal): string {
    return this.scanned.bare.slice(literal.end).trimStart();
  }

  private checkModule(offset: number, literal: Literal): void {
    if (literal.raw.includes('\\')) return this.never(offset, `a module name with escape sequences ('${literal.raw}')`);
    const specifier = literal.raw;
    const base = moduleBase(specifier);
    if (EXEC_MODULES.has(base) && this.permissions.exec !== true) this.add(offset, `import of '${specifier}' (runs commands)`, 'declare exec: true in permissions');
    if (FS_MODULES.has(base) && !this.fsRead()) this.add(offset, `import of '${specifier}' (uses the filesystem)`, 'declare filesystem: "read" or "write" in permissions');
    if (NET_MODULES.has(base) && !this.hasNetwork()) this.add(offset, `import of '${specifier}' (uses the network)`, 'declare network in permissions');
  }

  private fsRead(): boolean {
    return this.permissions.filesystem === 'read' || this.permissions.filesystem === 'write';
  }

  private hasNetwork(): boolean {
    return (this.permissions.network?.length ?? 0) > 0;
  }

  private matchAll(pattern: RegExp, onMatch: (match: RegExpExecArray) => void): void {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(this.scanned.bare); match; match = pattern.exec(this.scanned.bare)) onMatch(match);
  }

  run(): ManifestFinding[] {
    this.checkImports();
    this.checkCalls();
    this.checkEnv();
    this.checkUrls();
    return this.findings.sort((a, b) => a.line - b.line);
  }

  private checkImports(): void {
    for (const pattern of [STATIC_IMPORT, STATIC_EXPORT]) {
      this.matchAll(pattern, (match) => {
        const literal = match[1] ? undefined : this.literalAt.get(match.index + match[0].length);
        if (literal) this.checkModule(match.index, literal);
      });
    }
    const dynamic = (pattern: RegExp, label: string) =>
      this.matchAll(pattern, (match) => {
        const literal = this.plainLiteralFrom(match.index + match[0].length);
        if (literal && /^[),]/.test(this.after(literal))) this.checkModule(match.index, literal);
        else this.never(match.index, `${label} with a non-literal argument`);
      });
    dynamic(/(?<![\w$.])import\s*\(/g, 'a dynamic import(');
    dynamic(/(?<![\w$])require\s*\(/g, 'a require(');
    this.matchAll(/(?<![\w$.])require(?![\w$])(?!\s*\()(?!\s*\.\s*resolve\s*\()/g, (match) => this.never(match.index, 'require used as a value'));
  }

  private checkCalls(): void {
    const { permissions } = this;
    if (permissions.exec !== true) this.matchAll(EXEC_SDK, (m) => this.add(m.index, `use of ${m[1]} (runs commands)`, 'declare exec: true in permissions'));
    if (!this.fsRead()) this.matchAll(FS_SDK, (m) => this.add(m.index, 'use of createFsTools (uses the filesystem)', 'declare filesystem: "read" or "write" in permissions'));
    if (permissions.filesystem !== 'write') this.matchAll(FS_WRITE_CALL, (m) => this.add(m.index, `a call to ${m[1]}() (writes files)`, 'declare filesystem: "write" in permissions'));
    if (!this.hasNetwork()) {
      this.matchAll(/(?<![\w$])fetch\s*\(/g, (m) => this.add(m.index, 'a call to fetch() (uses the network)', 'declare network in permissions'));
      this.matchAll(NET_SDK, (m) => this.add(m.index, 'use of createHttpTool (uses the network)', 'declare network in permissions'));
    }
    this.matchAll(/(?<![\w$])eval\s*\(/g, (m) => this.never(m.index, 'eval('));
    this.matchAll(/(?<![\w$])(?:new\s+)?Function\s*\(/g, (m) => this.never(m.index, 'new Function('));
  }

  private checkEnv(): void {
    const declared = new Set(this.permissions.env ?? []);
    const need = (offset: number, name: string) => {
      if (!declared.has(name)) this.add(offset, `reads process.env.${name}`, `declare env: ["${name}"] in permissions`);
    };
    this.matchAll(/(?<![\w$.])process\s*\.\s*env(?![\w$])/g, (match) => {
      const rest = match.index + match[0].length;
      const dotted = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(this.scanned.bare.slice(rest, rest + 200));
      if (dotted) return need(match.index, dotted[1]);
      const bracket = /^\s*(?:\?\.)?\s*\[/.exec(this.scanned.bare.slice(rest, rest + 20));
      if (!bracket) return this.never(match.index, 'process.env used as a whole object (read each variable as process.env.NAME)');
      const literal = this.plainLiteralFrom(rest + bracket[0].length);
      if (literal && ENV_NAME.test(literal.raw) && this.after(literal).startsWith(']')) return need(match.index, literal.raw);
      this.never(match.index, 'a computed process.env[...] read');
    });
  }

  private checkUrls(): void {
    const network = (this.permissions.network ?? []).map((host) => host.toLowerCase());
    for (const literal of this.scanned.literals) {
      URL_IN_TEXT.lastIndex = 0;
      for (let match = URL_IN_TEXT.exec(literal.raw); match; match = URL_IN_TEXT.exec(literal.raw)) {
        const offset = literal.start + match.index;
        const authority = match[1].slice(match[1].lastIndexOf('@') + 1);
        const host = authority.replace(/:\d*$/, '').replace(/^\[|\]$/g, '').toLowerCase();
        const atEnd = match.index + match[0].length === literal.raw.length;
        if (host === '' || (atEnd && literal.interpolated)) {
          if (network.length === 0) this.add(offset, 'a URL whose host is computed', 'declare network in permissions');
          else this.add(offset, 'a URL whose host is computed, so it could not be checked against network', 'read the file', 'note');
        } else if (!matchesHost(network, host)) {
          this.add(offset, `a URL to ${host}`, `declare network: ["${host}"] in permissions`);
        }
      }
    }
  }
}

/** Every finding for every code file of `item`, by file and line. Markdown and other non-code files are not scanned. */
export function checkItem(item: RegistryItem): ManifestFinding[] {
  return item.files.filter((file) => isCodeFile(file.path)).flatMap((file) => new FileCheck(file.path, file.content, item.permissions).run());
}
