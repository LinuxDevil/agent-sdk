import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from './ToolRegistry';
import { currentDateTool, dayNameTool } from './built-in';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register a tool', () => {
    registry.register('currentDate', currentDateTool);
    expect(registry.has('currentDate')).toBe(true);
  });

  it('should get a registered tool', () => {
    registry.register('currentDate', currentDateTool);
    const tool = registry.get('currentDate');
    expect(tool).toBeDefined();
    expect(tool?.displayName).toBe('Get current date');
  });

  it('should return undefined for unregistered tool', () => {
    const tool = registry.get('nonexistent');
    expect(tool).toBeUndefined();
  });

  it('should register multiple tools at once', () => {
    registry.registerMany({
      currentDate: currentDateTool,
      dayName: dayNameTool,
    });

    expect(registry.has('currentDate')).toBe(true);
    expect(registry.has('dayName')).toBe(true);
    expect(registry.size()).toBe(2);
  });

  it('should list all tool names', () => {
    registry.register('currentDate', currentDateTool);
    registry.register('dayName', dayNameTool);

    const names = registry.list();
    expect(names).toContain('currentDate');
    expect(names).toContain('dayName');
    expect(names).toHaveLength(2);
  });

  it('should get all tools', () => {
    registry.register('currentDate', currentDateTool);
    registry.register('dayName', dayNameTool);

    const all = registry.getAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.currentDate).toBeDefined();
    expect(all.dayName).toBeDefined();
  });

  it('should unregister a tool', () => {
    registry.register('currentDate', currentDateTool);
    expect(registry.has('currentDate')).toBe(true);

    const result = registry.unregister('currentDate');
    expect(result).toBe(true);
    expect(registry.has('currentDate')).toBe(false);
  });

  it('should return false when unregistering non-existent tool', () => {
    const result = registry.unregister('nonexistent');
    expect(result).toBe(false);
  });

  it('should clear all tools', () => {
    registry.register('currentDate', currentDateTool);
    registry.register('dayName', dayNameTool);
    expect(registry.size()).toBe(2);

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it('should warn when overwriting a tool', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    registry.register('currentDate', currentDateTool);
    registry.register('currentDate', dayNameTool); // Overwrite

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Tool 'currentDate' is already registered")
    );

    consoleSpy.mockRestore();
  });

  it('should return correct size', () => {
    expect(registry.size()).toBe(0);

    registry.register('currentDate', currentDateTool);
    expect(registry.size()).toBe(1);

    registry.register('dayName', dayNameTool);
    expect(registry.size()).toBe(2);

    registry.unregister('currentDate');
    expect(registry.size()).toBe(1);
  });
});
