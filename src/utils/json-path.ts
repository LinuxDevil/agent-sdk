import { newId } from './id';

/**
 * Recursively traverses the given object (and its children via "input" and "item")
 * updating each node's "name" property to reflect the path of agents from the root.
 */
export function setRecursiveNames(obj: any, path: string[] = []): void {
  // Skip if not an object
  if (!isTraversable(obj)) {
    return;
  }

  if (!obj.id) {
    obj.id = newId();
  }

  // If this node has an 'agent', extend our path
  let childPath = path;
  if (typeof obj.agent === 'string') {
    childPath = [...path, obj.agent];
    // Update the node's name to be the full path joined by " > "
    obj.name = childPath.join(' > ');
  }

  // Go deeper through "input" and "item" whether or not this node had an 'agent'
  visitChildren(obj.input, childPath);
  visitChildren(obj.item, childPath);
}

function isTraversable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** Recurse into a child slot that may hold an array of nodes or a single node. */
function visitChildren(child: unknown, path: string[]): void {
  if (Array.isArray(child)) {
    for (const item of child) {
      setRecursiveNames(item, path);
    }
  } else if (isTraversable(child)) {
    setRecursiveNames(child, path);
  }
}

/**
 * Get an object property by JSON path notation (e.g., "$.user.name" or "$.items[0]")
 * @param obj - The object to traverse
 * @param path - The JSON path string starting with "$"
 * @returns The value at the specified path or undefined if not found
 */
export function getObjectByPath(obj: any, path: string): any {
  if (!path.startsWith('$')) {
    throw new Error("Invalid path: Path should start with '$'");
  }

  // Regex to split path correctly while keeping array indices
  const keys = path
    .replace(/\[(\d+)\]/g, '.$1') // Convert array indices to dot notation (e.g., "f[2]" → "f.2")
    .slice(2) // Remove the "$."
    .split('.');

  let current = obj;
  for (const key of keys) {
    if (!hasOwnKey(current, key)) {
      return undefined; // Return undefined if path is invalid
    }
    current = current[key];
  }

  return current;
}

function hasOwnKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}
