/// <reference types="jest" />
import { startGameSync, type SyncDeps } from '@/features/game/sync';
import type { GameChannelHandlers } from '@/lib/realtime';
import { useGameStore } from '@/store/gameStore';
import { Fixture } from './fixtures';

/** Harness around startGameSync with a fake channel, fake AppState and a counting refresh. */
function harness(opts: { localVersion?: number } = {}) {
  let version = opts.localVersion ?? 5;
  let handlers: GameChannelHandlers | null = null;
  let appListener: ((s: 'active' | 'background' | 'inactive') => void) | null = null;
  let appNow: 'active' | 'background' | 'inactive' = 'active';
  const refresh = jest.fn(async (): Promise<void> => undefined);
  const unsubscribe = jest.fn();
  const removeApp = jest.fn();
  const subscribe = jest.fn((h: GameChannelHandlers) => {
    handlers = h;
    return unsubscribe;
  });
  const deps: SyncDeps = {
    refresh,
    localVersion: () => version,
    subscribe,
    setHealth: jest.fn(),
    setOnline: jest.fn(),
    appState: {
      current: () => appNow,
      onChange: (cb) => {
        appListener = cb;
        return { remove: removeApp };
      },
    },
    pollMs: 5000,
  };
  const stop = startGameSync(deps);
  return {
    refresh,
    subscribe,
    unsubscribe,
    removeApp,
    stop,
    channel: () => handlers!,
    setLocal: (v: number) => {
      version = v;
    },
    app: (s: 'active' | 'background' | 'inactive') => {
      appNow = s;
      appListener!(s);
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('game sync lifecycle', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('exactly one subscription; initial fetch + one reconcile when the channel first goes live', async () => {
    const h = harness();
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    h.channel().onHealth('connecting');
    h.channel().onHealth('live');
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('two idle devices: a healthy connection does NOT poll or refetch, however long it stays idle', async () => {
    const h = harness();
    h.channel().onHealth('live');
    h.refresh.mockClear();
    jest.advanceTimersByTime(30 * 60_000);
    await flush();
    expect(h.refresh).not.toHaveBeenCalled();
    // Presence chatter and echoes of the version we already have don't refetch either.
    h.channel().onPresence(['a', 'b']);
    h.channel().onState({ version: 5, events: [] });
    h.channel().onState({ version: 4, events: [] });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a real change: one broadcast ahead of us → exactly one refetch', async () => {
    const h = harness();
    h.channel().onHealth('live');
    h.refresh.mockClear();
    h.refresh.mockImplementation(async () => h.setLocal(6));
    h.channel().onState({ version: 6, events: [] });
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // Duplicate delivery of the same broadcast after reconciling: nothing.
    h.channel().onState({ version: 6, events: [] });
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('a burst of broadcasts while a refetch is in flight is coalesced', async () => {
    const h = harness();
    h.channel().onHealth('live');
    h.refresh.mockClear();
    let release!: () => void;
    h.refresh.mockImplementationOnce(() => new Promise<void>((r) => (release = () => (h.setLocal(8), r()))));
    h.channel().onState({ version: 6, events: [] });
    h.channel().onState({ version: 7, events: [] });
    h.channel().onState({ version: 8, events: [] });
    release();
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('fallback polling only while realtime is down; stops when live again (+ one reconcile)', async () => {
    const h = harness();
    h.channel().onHealth('live');
    h.refresh.mockClear();
    h.channel().onHealth('down');
    jest.advanceTimersByTime(5000);
    await flush();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(2);
    h.channel().onHealth('live');
    expect(h.refresh).toHaveBeenCalledTimes(3); // reconnect reconcile, once
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(h.refresh).toHaveBeenCalledTimes(3);
  });

  it('foreground after background refetches once; repeated "active" events do not', async () => {
    const h = harness();
    h.channel().onHealth('live');
    h.refresh.mockClear();
    h.app('active');
    expect(h.refresh).not.toHaveBeenCalled();
    h.app('background');
    h.app('active');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('cleans everything up on unmount', async () => {
    const h = harness();
    h.channel().onHealth('down');
    h.stop();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.removeApp).toHaveBeenCalledTimes(1);
    h.refresh.mockClear();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe('store reconciliation', () => {
  it('a refetch of the same version does not replace the snapshot (no re-render loop)', () => {
    const f = new Fixture().loadAs('Asha');
    const before = useGameStore.getState().snapshot;
    expect(useGameStore.getState().applySnapshot({ ...f.snapshot(), serverTime: 'later' })).toBe(false);
    expect(useGameStore.getState().snapshot).toBe(before);
  });

  it('identical presence lists do not update the store', () => {
    useGameStore.getState().setOnline(['b', 'a']);
    const first = useGameStore.getState().onlinePlayerIds;
    useGameStore.getState().setOnline(['a', 'b']);
    expect(useGameStore.getState().onlinePlayerIds).toBe(first);
  });
});
