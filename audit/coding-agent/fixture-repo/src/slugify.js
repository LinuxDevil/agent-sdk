/**
 * Turn a title into a URL slug: lower case, ASCII letters and digits,
 * words joined by single dashes, no leading or trailing dash.
 *   slugify('  Hello, World!  ') === 'hello-world'
 */
export function slugify(input) {
  return String(input)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
