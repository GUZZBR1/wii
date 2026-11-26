import { describe, expect, it } from 'vitest';
import { preferredDelegate } from '../src/cv/delegate';

describe('vision delegate', () => {
  it('defaults to the CPU and only uses the GPU when asked', () => {
    expect(preferredDelegate('')).toBe('CPU');
    expect(preferredDelegate('?delegate=gpu')).toBe('GPU');
  });
});
