import { nanoid } from 'nanoid';

/**
 * Recursively traverses the given object (and its children via "input" and "item")
 * updating each node's "name" property to reflect the path of agents from the root.
 */
export function setRecursiveNames(obj: any, path: string[] = []): void {
  // Skip if not an object
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (!obj.id) {
    obj.id = nanoid();
  }

  // If this node has an 'agent', extend our path
  if (typeof obj.agent === 'string') {
    const newPath = [...path, obj.agent];
    // Update the node's name to be the full path joined by " > "
    obj.name = newPath.join(' > ');

    // Recursively handle "input"
    if (Array.isArray(obj.input)) {
      for (const child of obj.input) {
        setRecursiveNames(child, newPath);
      }
    } else if (obj.input && typeof obj.input === 'object') {
      setRecursiveNames(obj.input, newPath);
    }

    // Recursively handle "item"
    if (Array.isArray(obj.item)) {
      for (const child of obj.item) {
        setRecursiveNames(child, newPath);
      }
    } else if (obj.item && typeof obj.item === 'object') {
      setRecursiveNames(obj.item, newPath);
    }
  } else {
    // Even if there's no 'agent', we should still go deeper if "input" or "item" exist
    if (Array.isArray(obj.input)) {
      for (const child of obj.input) {
        setRecursiveNames(child, path);
      }
    } else if (obj.input && typeof obj.input === 'object') {
      setRecursiveNames(obj.input, path);
    }

    if (Array.isArray(obj.item)) {
      for (const child of obj.item) {
        setRecursiveNames(child, path);
      }
    } else if (obj.item && typeof obj.item === 'object') {
      setRecursiveNames(obj.item, path);
    }
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
    if (typeof current !== 'object' || current === null || !current.hasOwnProperty(key)) {
      return undefined; // Return undefined if path is invalid
    }
    current = current[key];
  }

  return current;
}
