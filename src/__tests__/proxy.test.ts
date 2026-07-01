import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { proxyShell, ensureProxy, killProxy, killAllProxies, refreshProxy } from '../proxy.js';

function makeFakeProcess() {
  const ee = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  ee.kill = vi.fn();
  ee.unref = vi.fn();
  ee.exitCode = null;
  return ee;
}

describe('ensureProxy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    killAllProxies();
  });

  afterEach(() => {
    killAllProxies();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts sshuttle and stores entry', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const promise = ensureProxy('key1', 'user@bastion', '10.0.0.1', '6443', 60);
    // Advance past the 1s startup window
    await vi.advanceTimersByTimeAsync(1100);
    await promise;

    expect(proxyShell.spawn).toHaveBeenCalledWith('user@bastion', '10.0.0.1', '6443');
    expect(fakeProc.unref).toHaveBeenCalled();
  });

  it('refreshes timer on repeated call without restarting', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const p1 = ensureProxy('key2', 'user@bastion', '10.0.0.1', '6443', 60);
    await vi.advanceTimersByTimeAsync(1100);
    await p1;

    // Second call should not spawn again
    await ensureProxy('key2', 'user@bastion', '10.0.0.1', '6443', 60);
    expect(proxyShell.spawn).toHaveBeenCalledTimes(1);
  });

  it('kills proxy after TTL expires', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const p = ensureProxy('key3', 'user@bastion', '10.0.0.1', '6443', 60);
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    // Advance past TTL
    vi.advanceTimersByTime(61_000);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects if sshuttle exits during startup window', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const promise = ensureProxy('key4', 'user@bastion', '10.0.0.1', '6443', 60);
    // Simulate sshuttle dying immediately
    fakeProc.emit('exit', 1);

    await expect(promise).rejects.toThrow(/exited early/);
  });
});

describe('refreshProxy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    killAllProxies();
  });

  afterEach(() => {
    killAllProxies();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('extends proxy TTL', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const p = ensureProxy('key5', 'user@bastion', '10.0.0.1', '6443', 60);
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    // After 50s, refresh the timer
    vi.advanceTimersByTime(50_000);
    refreshProxy('key5', 60);

    // At 100s total (50s after refresh) proxy should still be alive
    vi.advanceTimersByTime(50_000);
    expect(fakeProc.kill).not.toHaveBeenCalled();

    // At 110s total (60s after last refresh) it should be killed
    vi.advanceTimersByTime(10_000);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('killProxy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    killAllProxies();
  });

  afterEach(() => {
    killAllProxies();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('kills process and removes from store', async () => {
    const fakeProc = makeFakeProcess();
    vi.spyOn(proxyShell, 'spawn').mockReturnValue(fakeProc as never);

    const p = ensureProxy('key6', 'user@bastion', '10.0.0.1', '6443', 60);
    await vi.advanceTimersByTimeAsync(1100);
    await p;

    killProxy('key6');
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    // Calling again should be a no-op
    killProxy('key6');
    expect(fakeProc.kill).toHaveBeenCalledTimes(1);
  });
});
