import { describe, expect, it } from 'vitest';
import { diagnosticsEnabled, preferredDelegate } from '../src/cv/delegate';

describe('vision delegate', () => {
  it('defaults to the CPU and only uses the GPU when asked', () => {
    expect(preferredDelegate('')).toBe('CPU');
    expect(preferredDelegate('?delegate=gpu')).toBe('GPU');
  });

  it('keeps the diagnostic keys away from visitors of a production build', () => {
    expect(diagnosticsEnabled('', false)).toBe(false);
    expect(diagnosticsEnabled('?debug', false)).toBe(true);
    expect(diagnosticsEnabled('?fotos', false)).toBe(true);
    expect(diagnosticsEnabled('', true)).toBe(true);
  });
});
