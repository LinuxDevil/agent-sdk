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

    const [match, prefix, syntax, content, postFix] = matches;
    const lang = syntax || 'none';
    const lineNumber = getLineNumber(block, matches);
    let hasError = false;

    /* Validate code blocks */
    if (prefix && prefix.match(/\S/)) {
      hasError = true;
      errors.push({
        line: lineNumber,
        position: matches.index,
        message: `Prefix "${prefix}" not allowed on line ${lineNumber}. Remove it to fix the code block.`,
        block: match,
      });
    }

    if (postFix && postFix.match(/\S/)) {
      hasError = true;
      const line = lineNumber + (countLines(match) - 1);
      errors.push({
        line,
        position: matches.index + match.length,
        message: `Postfix "${postFix}" not allowed on line ${line}. Remove it to fix the code block.`,
        block: match,
      });
    }

    if (!hasError) {
      blocks.push({
        line: lineNumber,
        position: matches.index,
        syntax: lang,
        block: match,
        code: content.trim(),
      });
    }
  }

  if (blocks.length === 0 && singleBlockMode) {
    blocks.push({
      line: 0,
      position: 0,
      syntax: '',
      block: '',
      code: block.trim(),
    });
  }

  return {
    errors,
    blocks,
  };
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
