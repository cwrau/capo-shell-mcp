import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TTLCache, clusterListKey, kubeconfigKey } from '../cache.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined for missing key', () => {
    const c = new TTLCache<string, string>(60);
    expect(c.get('missing')).toBeUndefined();
  });

  it('returns value within TTL', () => {
    const c = new TTLCache<string, string>(60);
    c.set('k', 'v');
    vi.advanceTimersByTime(59_000);
    expect(c.get('k')).toBe('v');
  });

  it('returns undefined after TTL expires', () => {
    const c = new TTLCache<string, string>(60);
    c.set('k', 'v');
    vi.advanceTimersByTime(61_000);
    expect(c.get('k')).toBeUndefined();
  });

  it('delete removes the entry', () => {
    const c = new TTLCache<string, string>(60);
    c.set('k', 'v');
    c.delete('k');
    expect(c.get('k')).toBeUndefined();
  });

  it('clear removes all entries', () => {
    const c = new TTLCache<string, string>(60);
    c.set('a', '1');
    c.set('b', '2');
    c.clear();
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
  });

  it('set overwrites existing entry and resets TTL', () => {
    const c = new TTLCache<string, string>(60);
    c.set('k', 'old');
    vi.advanceTimersByTime(50_000);
    c.set('k', 'new');
    vi.advanceTimersByTime(50_000);
    expect(c.get('k')).toBe('new');
  });
});

describe('key helpers', () => {
  it('clusterListKey', () => {
    expect(clusterListKey('prod', 'prod-admin')).toBe('prod:prod-admin');
  });

  it('kubeconfigKey', () => {
    expect(kubeconfigKey('prod', 'prod-admin', 'default', 'my-cluster')).toBe(
      'prod:prod-admin:default:my-cluster',
    );
  });
});
