/**
 * Get current timestamp in formatted string
 */
export function getCurrentTS(): string {
  return getTS();
}

/**
 * Format date to timestamp string (YYYY-MM-DD HH:MM:SS)
 */
export function getTS(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const formattedDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

  return formattedDate;
}

/**
 * Format date to locale string
 */
export function formatDate(date: Date): string {
  return date.toLocaleString();
}

/**
 * Safe JSON parse with default value
 */
export function safeJsonParse<T = any>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

/**
 * Remove markdown code blocks from text
 */
export function removeCodeBlocks(text: string): string {
  const PATTERN = /^([A-Za-z \t]*)```([A-Za-z]*)?\n([\s\S]*?)```([A-Za-z \t]*)*$/gm;
  return text.replace(PATTERN, '');
}

/**
 * Count lines in text
 */
function countLines(text = ''): number {
  return text.split('\n').length;
}

/**
 * Get line number from text and regex match
 */
function getLineNumber(text = '', matches: any): number {
  return countLines(text.substr(0, matches.index));
}

export interface CodeBlock {
  line: number;
  position: number;
  syntax: string;
  block: string;
  code: string;
}

export interface CodeBlockError {
  line: number;
  position: number;
  message: string;
  block: string;
}

export interface CodeBlockResult {
  errors: CodeBlockError[];
  blocks: CodeBlock[];
}

/**
 * Find and extract code blocks from markdown text
 */
export function findCodeBlocks(block: string, singleBlockMode = true): CodeBlockResult {
  const PATTERN = /^([A-Za-z \t]*)```([A-Za-z]*)?\n([\s\S]*?)```([A-Za-z \t]*)*$/gm;
  let matches;
  const errors: CodeBlockError[] = [];
  const blocks: CodeBlock[] = [];

  while ((matches = PATTERN.exec(block)) !== null) {
    if (matches.index === PATTERN.lastIndex) {
      PATTERN.lastIndex++; // avoid infinite loops with zero-width matches
    }

    const blockErrors = validateCodeBlockMatch(block, matches);
    if (blockErrors.length > 0) {
      errors.push(...blockErrors);
    } else {
      blocks.push(toCodeBlock(block, matches));
    }
  }

  return {
    errors,
    blocks: withSingleBlockFallback(blocks, block, singleBlockMode),
  };
}

/** Validate a code block match: no prefix before the opening fence, no postfix after the closing one. */
function validateCodeBlockMatch(text: string, matches: RegExpExecArray): CodeBlockError[] {
  const lineNumber = getLineNumber(text, matches);
  const errors = [prefixError(matches, lineNumber), postfixError(matches, lineNumber)];
  return errors.filter((error): error is CodeBlockError => error !== null);
}

function prefixError(matches: RegExpExecArray, lineNumber: number): CodeBlockError | null {
  const [match, prefix] = matches;
  if (!prefix || !prefix.match(/\S/)) return null;

  return {
    line: lineNumber,
    position: matches.index,
    message: `Prefix "${prefix}" not allowed on line ${lineNumber}. Remove it to fix the code block.`,
    block: match,
  };
}

function postfixError(matches: RegExpExecArray, lineNumber: number): CodeBlockError | null {
  const [match, , , , postFix] = matches;
  if (!postFix || !postFix.match(/\S/)) return null;

  const line = lineNumber + (countLines(match) - 1);
  return {
    line,
    position: matches.index + match.length,
    message: `Postfix "${postFix}" not allowed on line ${line}. Remove it to fix the code block.`,
    block: match,
  };
}

function toCodeBlock(text: string, matches: RegExpExecArray): CodeBlock {
  const [match, , syntax, content] = matches;
  return {
    line: getLineNumber(text, matches),
    position: matches.index,
    syntax: syntax || 'none',
    block: match,
    code: content.trim(),
  };
}

/** In single-block mode, treat the whole text as one block when no fenced blocks were found. */
function withSingleBlockFallback(blocks: CodeBlock[], text: string, singleBlockMode: boolean): CodeBlock[] {
  if (blocks.length > 0 || !singleBlockMode) return blocks;
  return [
    {
      line: 0,
      position: 0,
      syntax: '',
      block: '',
      code: text.trim(),
    },
  ];
}

/**
 * Check if API key is provided, throw error if not
 */
export function checkApiKey(name: string, key: string, value: string): string {
  if (value) return value;

  throw new Error(
    `Please provide the ${name} API key in the environment variable ${key}`
  );
}
