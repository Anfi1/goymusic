import { describe, it, expect } from 'vitest';
import { resolveSource } from './source';

describe('resolveSource', () => {
  it('возвращает youtube для youtube', () => {
    expect(resolveSource('youtube')).toBe('youtube');
  });
  it('возвращает soundcloud для soundcloud', () => {
    expect(resolveSource('soundcloud')).toBe('soundcloud');
  });
  it('дефолтит на youtube для undefined/null', () => {
    expect(resolveSource(undefined)).toBe('youtube');
    expect(resolveSource(null)).toBe('youtube');
  });
  it('дефолтит на youtube для неизвестных значений', () => {
    expect(resolveSource('spotify')).toBe('youtube');
    expect(resolveSource(42)).toBe('youtube');
  });
  it('игнорирует регистр', () => {
    expect(resolveSource('SoundCloud')).toBe('soundcloud');
  });
});
