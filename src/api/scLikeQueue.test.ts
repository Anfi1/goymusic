import { describe, it, expect, vi } from 'vitest';
import type { YTMTrack } from './yt';
import { ScLikeQueue } from './scLikeQueue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTrack(scId: string, overrides: Partial<YTMTrack> = {}): YTMTrack {
  return {
    id: `https://soundcloud.com/artist/${scId}`,
    scId,
    scUrl: `https://soundcloud.com/artist/${scId}`,
    title: `Track ${scId}`,
    artists: ['Artist'],
    album: '',
    duration: '3:00',
    thumbUrl: '',
    source: 'soundcloud',
    ...overrides,
  };
}

describe('ScLikeQueue', () => {
  it('вызывает applyLocal синхронно, держит pending во время in-flight и очищает после успеха', async () => {
    const track = makeTrack('101');
    const deferred = createDeferred<boolean>();
    const events: string[] = [];

    const applyLocal = vi.fn((t: YTMTrack, liked: boolean) => {
      events.push(`local:${t.scId}:${liked}`);
    });
    const persistRemote = vi.fn((scId: string, _scUrl: string, liked: boolean) => {
      events.push(`remote:${scId}:${liked}`);
      return deferred.promise;
    });
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(track, false, true);

    expect(events).toEqual(['local:101:true', 'remote:101:true']);
    expect(applyLocal).toHaveBeenCalledTimes(1);
    expect(applyLocal).toHaveBeenCalledWith(track, true);
    expect(persistRemote).toHaveBeenCalledTimes(1);
    expect(persistRemote).toHaveBeenCalledWith('101', track.scUrl, true);
    expect(queue.hasPending()).toBe(true);
    expect(queue.hasPending('101')).toBe(true);
    expect(queue.hasPending('999')).toBe(false);

    const pending = queue.getPendingChanges();
    expect(pending.size).toBe(1);
    expect(pending.get('101')).toEqual({ track, liked: true });

    // Внешняя мутация копии Map не должна влиять на очередь
    pending.clear();
    expect(queue.getPendingChanges().size).toBe(1);

    deferred.resolve(true);
    await queue.whenIdle();

    expect(queue.hasPending()).toBe(false);
    expect(queue.hasPending('101')).toBe(false);
    expect(queue.getPendingChanges().size).toBe(0);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('схлопывает pre-flight переключения false -> true -> false без сетевого запроса', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    const deferredA = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn((scId: string) => {
      if (scId === 'a') return deferredA.promise;
      return Promise.resolve(true);
    });
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackB, false, true);
    queue.enqueue(trackB, true, false);

    expect(applyLocal).toHaveBeenNthCalledWith(2, trackB, true);
    expect(applyLocal).toHaveBeenNthCalledWith(3, trackB, false);

    deferredA.resolve(true);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledTimes(1);
    expect(persistRemote).toHaveBeenCalledWith('a', trackA.scUrl, true);
    expect(queue.hasPending()).toBe(false);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('схлопывает pre-flight серию false -> true -> false -> true в 1 запрос с liked=true', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    const deferredA = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn((scId: string) => {
      if (scId === 'a') return deferredA.promise;
      return Promise.resolve(true);
    });
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackB, false, true);
    queue.enqueue(trackB, true, false);
    queue.enqueue(trackB, false, true);

    expect(queue.getPendingChanges().get('b')).toEqual({ track: trackB, liked: true });

    deferredA.resolve(true);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(persistRemote).toHaveBeenNthCalledWith(1, 'a', trackA.scUrl, true);
    expect(persistRemote).toHaveBeenNthCalledWith(2, 'b', trackB.scUrl, true);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('досинкивает новое состояние, если пользователь переключил трек во время in-flight запроса', async () => {
    const trackA = makeTrack('a');
    const first = createDeferred<boolean>();
    const second = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackA, true, false);

    expect(queue.getPendingChanges().get('a')).toEqual({ track: trackA, liked: false });
    expect(persistRemote).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(persistRemote).toHaveBeenNthCalledWith(2, 'a', trackA.scUrl, false);
    expect(onRollback).not.toHaveBeenCalled();

    second.resolve(true);
    await queue.whenIdle();

    expect(queue.hasPending()).toBe(false);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('не шлет лишний запрос, если во время успешного in-flight пользователь вернулся к тому же targetLiked', async () => {
    const trackA = makeTrack('a');
    const first = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn(() => first.promise);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackA, true, false);
    queue.enqueue(trackA, false, true);

    first.resolve(true);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledTimes(1);
    expect(queue.hasPending()).toBe(false);
    expect(onRollback).not.toHaveBeenCalled();
  });

  it('вызывает onRollback и очищает pending, если persistRemote вернул false без новых кликов', async () => {
    const trackA = makeTrack('a');
    const deferred = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn(() => deferred.promise);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    deferred.resolve(false);
    await queue.whenIdle();

    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(onRollback).toHaveBeenCalledWith(trackA, false);
    expect(queue.getPendingChanges().size).toBe(0);
    expect(queue.hasPending()).toBe(false);
  });

  it('вызывает onRollback при исключении в persistRemote и продолжает работу очереди', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');

    const applyLocal = vi.fn();
    const persistRemote = vi.fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(true);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, true, false);
    queue.enqueue(trackB, false, true);
    await queue.whenIdle();

    expect(onRollback).toHaveBeenCalledTimes(1);
    expect(onRollback).toHaveBeenCalledWith(trackA, true);
    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(persistRemote).toHaveBeenNthCalledWith(2, 'b', trackB.scUrl, true);
    expect(queue.hasPending()).toBe(false);
  });

  it('при ошибке in-flight не вызывает onRollback и не шлет повтор, если пользователь уже вернул committedLiked', async () => {
    const trackA = makeTrack('a');
    const first = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn(() => first.promise);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackA, true, false);

    first.resolve(false);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledTimes(1);
    expect(onRollback).not.toHaveBeenCalled();
    expect(queue.hasPending()).toBe(false);
  });

  it('при ошибке in-flight досинкивает более новый выбор пользователя, отличающийся от committedLiked', async () => {
    const trackA = makeTrack('a');
    const first = createDeferred<boolean>();
    const second = createDeferred<boolean>();

    const applyLocal = vi.fn();
    const persistRemote = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackA, true, false);
    queue.enqueue(trackA, false, true);

    first.resolve(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(onRollback).not.toHaveBeenCalled();
    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(persistRemote).toHaveBeenNthCalledWith(2, 'a', trackA.scUrl, true);

    second.resolve(true);
    await queue.whenIdle();

    expect(onRollback).not.toHaveBeenCalled();
    expect(queue.hasPending()).toBe(false);
  });

  it('соблюдает строгую FIFO-сериализацию (maxConcurrent === 1) для разных треков', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    const trackC = makeTrack('c');
    const deferreds: Record<string, Deferred<boolean>> = {
      a: createDeferred<boolean>(),
      b: createDeferred<boolean>(),
      c: createDeferred<boolean>(),
    };

    let active = 0;
    let maxConcurrent = 0;
    const startedOrder: string[] = [];

    const persistRemote = vi.fn(async (scId: string) => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      startedOrder.push(scId);
      try {
        return await deferreds[scId].promise;
      } finally {
        active -= 1;
      }
    });

    const queue = new ScLikeQueue({
      applyLocal: vi.fn(),
      persistRemote,
      onRollback: vi.fn(),
    });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackB, true, false);
    queue.enqueue(trackC, false, true);

    expect(startedOrder).toEqual(['a']);

    deferreds.a.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(startedOrder).toEqual(['a', 'b']);

    deferreds.b.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(startedOrder).toEqual(['a', 'b', 'c']);

    deferreds.c.resolve(true);
    await queue.whenIdle();

    expect(maxConcurrent).toBe(1);
    expect(startedOrder).toEqual(['a', 'b', 'c']);
  });

  it('clear() во время in-flight сбрасывает очередь, игнорирует старый ответ и не блокирует новые задачи', async () => {
    const trackA = makeTrack('a');
    const trackB = makeTrack('b');
    const trackC = makeTrack('c');
    const deferredA = createDeferred<boolean>();
    const deferredC = createDeferred<boolean>();

    const persistRemote = vi.fn((scId: string) => {
      if (scId === 'a') return deferredA.promise;
      if (scId === 'c') return deferredC.promise;
      return Promise.resolve(true);
    });
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({
      applyLocal: vi.fn(),
      persistRemote,
      onRollback,
    });

    queue.enqueue(trackA, false, true);
    queue.enqueue(trackB, false, true);
    const idleBeforeClear = queue.whenIdle();

    queue.clear();

    await idleBeforeClear;
    expect(queue.hasPending()).toBe(false);
    expect(queue.getPendingChanges().size).toBe(0);

    // Новая задача после clear() запускается сразу, не дожидаясь старого deferredA
    queue.enqueue(trackC, false, true);
    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(persistRemote).toHaveBeenNthCalledWith(2, 'c', trackC.scUrl, true);

    // Старый неуспешный ответ для trackA не должен вызывать onRollback или ломать очередь
    deferredA.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(onRollback).not.toHaveBeenCalled();
    expect(queue.hasPending('c')).toBe(true);

    deferredC.resolve(true);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledTimes(2);
    expect(onRollback).not.toHaveBeenCalled();
    expect(queue.hasPending()).toBe(false);
  });

  it('корректно работает whenIdle() в пустом состоянии, fallback scId/scUrl к track.id и пустой идентификатор', async () => {
    const applyLocal = vi.fn();
    const persistRemote = vi.fn(async () => true);
    const onRollback = vi.fn();

    const queue = new ScLikeQueue({ applyLocal, persistRemote, onRollback });

    await queue.whenIdle();

    const emptyTrack = makeTrack('', { id: '', scId: '', scUrl: '' });
    queue.enqueue(emptyTrack, false, true);
    expect(applyLocal).not.toHaveBeenCalled();
    expect(persistRemote).not.toHaveBeenCalled();

    const fallbackTrack = makeTrack('', {
      id: 'https://soundcloud.com/fallback/track',
      scId: undefined,
      scUrl: undefined,
    });
    queue.enqueue(fallbackTrack, false, true);
    await queue.whenIdle();

    expect(persistRemote).toHaveBeenCalledWith(
      'https://soundcloud.com/fallback/track',
      'https://soundcloud.com/fallback/track',
      true,
    );
  });

  it('при мгновенном сбое persistRemote уступает макротаск перед onRollback и уважает повторный клик во время этого тика', async () => {
    const trackA = makeTrack('a');
    const order: string[] = [];

    const queue = new ScLikeQueue({
      applyLocal: (_t, liked) => { order.push(`local:${liked}`); },
      persistRemote: vi.fn(async () => false),
      onRollback: (_t, reverted) => { order.push(`rollback:${reverted}`); },
    });

    queue.enqueue(trackA, false, true);
    // Имитируем микротаски вызывающего кода (await toggleLike())
    await Promise.resolve();
    await Promise.resolve();
    order.push('caller-microtask');

    await queue.whenIdle();

    expect(order).toEqual(['local:true', 'caller-microtask', 'rollback:false']);

    // Повторный клик пользователя в том же тике до срабатывания макротаска отменяет onRollback
    const onRollback2 = vi.fn();
    const persistRemote2 = vi.fn(async () => false);
    const queue2 = new ScLikeQueue({
      applyLocal: vi.fn(),
      persistRemote: persistRemote2,
      onRollback: onRollback2,
    });

    queue2.enqueue(trackA, false, true);
    await Promise.resolve();
    queue2.enqueue(trackA, true, false);
    await queue2.whenIdle();

    expect(onRollback2).not.toHaveBeenCalled();
    expect(persistRemote2).toHaveBeenCalledTimes(1);
    expect(queue2.hasPending()).toBe(false);
  });
});
