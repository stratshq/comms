import { describe, it, expect } from 'vitest';
import { extractJsonObject } from '../src/openai-compat.js';

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses a fenced object, with or without the json tag', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in prose — the classic compat-server reply', () => {
    expect(
      extractJsonObject('Here is the classification you asked for:\n{"priority": "high"}\nHope that helps!'),
    ).toEqual({ priority: 'high' });
  });

  it('handles nested braces via the outermost span', () => {
    expect(extractJsonObject('result: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
  });

  it('refuses arrays, primitives and garbage', () => {
    expect(extractJsonObject('[1,2,3]')).toBeNull();
    expect(extractJsonObject('42')).toBeNull();
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});
