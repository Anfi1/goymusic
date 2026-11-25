import { describe, it, expect, vi } from 'vitest';
import {
  createUpdateStore,
  shouldShowUpdateBanner,
  type UpdateBridge,
  type UpdateCheckResponse,
  type UpdateSnapshot,
  type UpdateStatus,
} from './updateStore';

function createMockBridge(overrides: Partial<UpdateBridge> = {}) {
  let availableCb: ((info: { version: string; releaseNotes?: unknown }) => void) | null = null;
  let notAvailableCb: ((info: { version: string }) => void) | null = null;
  let progressCb: ((p: { percent: number; speed?: number; transferred?: number; total?: number }) => void) | null = null;
  let downloadedCb: (() => void) | null = null;
  let errorCb: ((err: { message?: string }) => void) | null = null;

  const unsubAvailable = vi.fn();
  const unsubNotAvailable = vi.fn();
  const unsubProgress = vi.fn();
  const unsubDownloaded = vi.fn();
  const unsubError = vi.fn();

  const bridge: UpdateBridge = {
    getAppVersion: vi.fn().mockResolvedValue('6.5.2'),
    checkForUpdates: vi.fn().mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '6.5.2',
    } satisfies UpdateCheckResponse),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    onUpdateAvailable: vi.fn((cb) => {
      availableCb = cb;
      return unsubAvailable;
    }),
    onUpdateNotAvailable: vi.fn((cb) => {
      notAvailableCb = cb;
      return unsubNotAvailable;
    }),
    onUpdateProgress: vi.fn((cb) => {
      progressCb = cb;
      return unsubProgress;
    }),
    onUpdateDownloaded: vi.fn((cb) => {
      downloadedCb = cb;
      return unsubDownloaded;
    }),
    onUpdateError: vi.fn((cb) => {
      errorCb = cb;
      return unsubError;
    }),
    ...overrides,
  };

  return {
    bridge,
    emitAvailable: (version: string) => availableCb?.({ version }),
    emitNotAvailable: (version: string) => notAvailableCb?.({ version }),
    emitProgress: (percent: number) => progressCb?.({ percent }),
    emitDownloaded: () => downloadedCb?.(),
    emitError: (message: string) => errorCb?.({ message }),
    unsubs: {
      unsubAvailable,
      unsubNotAvailable,
      unsubProgress,
      unsubDownloaded,
      unsubError,
    },
  };
}

describe('updateStore', () => {
  it('загружает текущую версию приложения и стартует в idle', async () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    expect(store.getSnapshot().status).toBe('idle');
    expect(store.getSnapshot().bannerDismissed).toBe(false);
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);

    await Promise.resolve();
    expect(store.getSnapshot().currentVersion).toBe('6.5.2');
  });

  it('показывает баннер при update:available и прячет на всю сессию после dismissBanner', async () => {
    const mock = createMockBridge({
      checkForUpdates: vi.fn().mockResolvedValue({
        status: 'available',
        version: '6.6.0',
        currentVersion: '6.5.2',
      } satisfies UpdateCheckResponse),
    });
    const store = createUpdateStore(mock.bridge);

    mock.emitAvailable('6.6.0');
    expect(store.getSnapshot().status).toBe('available');
    expect(store.getSnapshot().availableVersion).toBe('6.6.0');
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(true);

    // Пользователь нажал "Позже"
    store.dismissBanner();
    expect(store.getSnapshot().bannerDismissed).toBe(true);
    expect(store.getSnapshot().status).toBe('available');
    expect(store.getSnapshot().availableVersion).toBe('6.6.0');
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);

    // Повторное почасовое событие update:available не открывает баннер снова
    mock.emitAvailable('6.6.0');
    expect(store.getSnapshot().bannerDismissed).toBe(true);
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);

    // Новая версия при следующей проверке в той же сессии тоже не открывает баннер
    mock.emitAvailable('6.7.0');
    expect(store.getSnapshot().availableVersion).toBe('6.7.0');
    expect(store.getSnapshot().bannerDismissed).toBe(true);
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);

    // Ручная проверка из настроек тоже не сбрасывает dismiss
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('available');
    expect(store.getSnapshot().bannerDismissed).toBe(true);
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);
  });

  it('показывает баннер снова после перезапуска приложения (новый экземпляр store)', () => {
    const mock1 = createMockBridge();
    const firstSession = createUpdateStore(mock1.bridge);
    mock1.emitAvailable('6.6.0');
    firstSession.dismissBanner();
    expect(shouldShowUpdateBanner(firstSession.getSnapshot())).toBe(false);

    const mock2 = createMockBridge();
    const restartedSession = createUpdateStore(mock2.bridge);
    mock2.emitAvailable('6.6.0');
    expect(restartedSession.getSnapshot().bannerDismissed).toBe(false);
    expect(shouldShowUpdateBanner(restartedSession.getSnapshot())).toBe(true);
  });

  it('не откатывает downloading и downloaded обратно в available при повторном update:available', async () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    mock.emitAvailable('6.6.0');
    await store.downloadUpdate();
    mock.emitProgress(42.6);

    expect(store.getSnapshot().status).toBe('downloading');
    expect(store.getSnapshot().progress).toBe(43);

    mock.emitAvailable('6.7.0');
    expect(store.getSnapshot().status).toBe('downloading');
    expect(store.getSnapshot().availableVersion).toBe('6.6.0');
    expect(store.getSnapshot().progress).toBe(43);

    mock.emitDownloaded();
    expect(store.getSnapshot().status).toBe('downloaded');
    expect(store.getSnapshot().availableVersion).toBe('6.6.0');
    expect(store.getSnapshot().progress).toBe(100);

    // Новая версия из почасовой проверки не подменяет версию уже скачанного релиза
    mock.emitAvailable('6.8.0');
    expect(store.getSnapshot().status).toBe('downloaded');
    expect(store.getSnapshot().availableVersion).toBe('6.6.0');
    expect(store.getSnapshot().progress).toBe(100);

    // Запоздалый прогресс тоже не откатывает downloaded
    mock.emitProgress(99);
    expect(store.getSnapshot().status).toBe('downloaded');
    expect(store.getSnapshot().progress).toBe(100);
  });

  it('сохраняет bannerDismissed при загрузке и завершении скачивания из настроек', async () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    mock.emitAvailable('6.6.0');
    store.dismissBanner();

    await store.downloadUpdate();
    mock.emitProgress(55);
    expect(store.getSnapshot().status).toBe('downloading');
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);

    mock.emitDownloaded();
    expect(store.getSnapshot().status).toBe('downloaded');
    expect(store.getSnapshot().progress).toBe(100);
    expect(shouldShowUpdateBanner(store.getSnapshot())).toBe(false);
  });

  it('сбрасывает зависшую загрузку или проверку при update:error, но не ломает idle/available/downloaded', async () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    // Фоновая ошибка в idle не засоряет состояние
    mock.emitError('background offline error');
    expect(store.getSnapshot().status).toBe('idle');

    // Фоновая ошибка в available не затирает найденное обновление
    mock.emitAvailable('6.6.0');
    mock.emitError('periodic network blip');
    expect(store.getSnapshot().status).toBe('available');

    // Ошибка во время скачивания переводит в error и снимает зависание
    await store.downloadUpdate();
    mock.emitProgress(20);
    mock.emitError('Connection reset');
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().errorMessage).toBe('Connection reset');
    expect(store.getSnapshot().progress).toBe(0);

    // Ошибка после скачивания не сбрасывает downloaded
    mock.emitDownloaded();
    mock.emitError('late error');
    expect(store.getSnapshot().status).toBe('downloaded');
  });

  it('обрабатывает dev, up-to-date, available и error из checkForUpdates', async () => {
    const checkMock = vi.fn<() => Promise<UpdateCheckResponse>>();
    const mock = createMockBridge({ checkForUpdates: checkMock });
    const store = createUpdateStore(mock.bridge);

    checkMock.mockResolvedValueOnce({ status: 'dev', currentVersion: '6.5.2' });
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('idle');
    expect(store.getSnapshot().isDevBuild).toBe(true);

    checkMock.mockResolvedValueOnce({ status: 'up-to-date', currentVersion: '6.5.2' });
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('up-to-date');
    expect(store.getSnapshot().isDevBuild).toBe(false);

    checkMock.mockResolvedValueOnce({ status: 'available', version: '6.6.1', currentVersion: '6.5.2' });
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('available');
    expect(store.getSnapshot().availableVersion).toBe('6.6.1');

    checkMock.mockResolvedValueOnce({ status: 'error', currentVersion: '6.5.2', message: 'GitHub 503' });
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().errorMessage).toBe('GitHub 503');

    checkMock.mockRejectedValueOnce(new Error('IPC timeout'));
    await store.checkForUpdates();
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().errorMessage).toBe('IPC timeout');
  });

  it('игнорирует checkForUpdates во время downloading и downloaded', async () => {
    const checkMock = vi.fn().mockResolvedValue({ status: 'up-to-date', currentVersion: '6.5.2' });
    const mock = createMockBridge({ checkForUpdates: checkMock });
    const store = createUpdateStore(mock.bridge);

    mock.emitAvailable('6.6.0');
    await store.downloadUpdate();
    await store.checkForUpdates();
    expect(checkMock).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('downloading');

    mock.emitDownloaded();
    await store.checkForUpdates();
    expect(checkMock).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('downloaded');
  });

  it('переводит downloadUpdate в error при отклонении промиса', async () => {
    const mock = createMockBridge({
      downloadUpdate: vi.fn().mockRejectedValue(new Error('Disk full')),
    });
    const store = createUpdateStore(mock.bridge);

    mock.emitAvailable('6.6.0');
    await store.downloadUpdate();
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().errorMessage).toBe('Disk full');
  });

  it('обрабатывает onUpdateNotAvailable и не перетирает активные статусы', () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    mock.emitNotAvailable('6.5.2');
    expect(store.getSnapshot().status).toBe('up-to-date');

    mock.emitAvailable('6.6.0');
    mock.emitNotAvailable('6.5.2');
    expect(store.getSnapshot().status).toBe('available');
  });

  it('вызывает bridge.installUpdate при installUpdate', async () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);

    await store.installUpdate();
    expect(mock.bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('уведомляет подписчиков только при изменении состояния и отписывает IPC в dispose', () => {
    const mock = createMockBridge();
    const store = createUpdateStore(mock.bridge);
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.dismissBanner();
    expect(listener).toHaveBeenCalledTimes(1);

    // Повторный dismiss не меняет снимок и не вызывает лишний рендер
    store.dismissBanner();
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    mock.emitAvailable('6.6.0');
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispose();
    expect(mock.unsubs.unsubAvailable).toHaveBeenCalledTimes(1);
    expect(mock.unsubs.unsubNotAvailable).toHaveBeenCalledTimes(1);
    expect(mock.unsubs.unsubProgress).toHaveBeenCalledTimes(1);
    expect(mock.unsubs.unsubDownloaded).toHaveBeenCalledTimes(1);
    expect(mock.unsubs.unsubError).toHaveBeenCalledTimes(1);
  });

  it('shouldShowUpdateBanner возвращает true только для available/downloading/downloaded и false при bannerDismissed', () => {
    const base: UpdateSnapshot = {
      currentVersion: '6.5.2',
      status: 'idle',
      availableVersion: '6.6.0',
      progress: 0,
      errorMessage: '',
      bannerDismissed: false,
      isDevBuild: false,
    };

    const expected: Record<UpdateStatus, boolean> = {
      idle: false,
      checking: false,
      'up-to-date': false,
      available: true,
      downloading: true,
      downloaded: true,
      error: false,
    };

    for (const [status, visible] of Object.entries(expected) as Array<[UpdateStatus, boolean]>) {
      expect(shouldShowUpdateBanner({ ...base, status, bannerDismissed: false })).toBe(visible);
      expect(shouldShowUpdateBanner({ ...base, status, bannerDismissed: true })).toBe(false);
    }
  });
});
