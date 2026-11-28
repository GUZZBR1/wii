// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateRenamedStorage } from '../src/lib/migrateStorage';

describe('storage after the rename', () => {
  beforeEach(() => localStorage.clear());

  it('moves what was saved under the old names', () => {
    localStorage.setItem('wii-mii-face-v1', 'face');
    localStorage.setItem('wii-athletics-records', '{"100":14}');
    localStorage.setItem('wii-web-sports.muted.v1', '1');
    localStorage.setItem('other', 'kept');
    migrateRenamedStorage(localStorage);
    expect(localStorage.getItem('nevergear-mii-face-v1')).toBe('face');
    expect(localStorage.getItem('nevergear-athletics-records')).toBe('{"100":14}');
    expect(localStorage.getItem('nevergear-web-sports.muted.v1')).toBe('1');
    expect(localStorage.getItem('wii-mii-face-v1')).toBeNull();
    expect(localStorage.getItem('other')).toBe('kept');
  });

  it('never overwrites something saved under the new name', () => {
    localStorage.setItem('wii-lang', 'en');
    localStorage.setItem('nevergear-lang', 'pt');
    migrateRenamedStorage(localStorage);
    expect(localStorage.getItem('nevergear-lang')).toBe('pt');
  });

  it('keeps the old value when the new one cannot be written', () => {
    localStorage.setItem('wii-lang', 'en');
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
    expect(() => migrateRenamedStorage(localStorage)).toThrow();
    write.mockRestore();
    expect(localStorage.getItem('wii-lang')).toBe('en');
  });
});
