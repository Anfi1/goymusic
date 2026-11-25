import { useSyncExternalStore } from 'react';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type UpdateCheckResponse =
  | { status: 'available'; version: string; currentVersion: string }
  | { status: 'up-to-date'; currentVersion: string }
  | { status: 'dev'; currentVersion: string }
  | { status: 'error'; currentVersion: string; message: string };

export interface UpdateSnapshot {
  currentVersion: string;
  status: UpdateStatus;
  availableVersion: string;
  progress: number;
  errorMessage: string;
  bannerDismissed: boolean;
  isDevBuild: boolean;
  checkedManually: boolean;
}

export interface UpdateBridge {
  getAppVersion?: () => Promise<string>;
  checkForUpdates?: () => Promise<UpdateCheckResponse | null>;
  downloadUpdate?: () => Promise<void>;
  installUpdate?: () => Promise<void>;
  onUpdateAvailable?: (
    callback: (info: { version: string; releaseNotes?: unknown }) => void
  ) => (() => void) | void;
  onUpdateNotAvailable?: (
    callback: (info: { version: string }) => void
  ) => (() => void) | void;
  onUpdateProgress?: (
    callback: (progress: { percent: number; speed?: number; transferred?: number; total?: number }) => void
  ) => (() => void) | void;
  onUpdateDownloaded?: (callback: () => void) => (() => void) | void;
  onUpdateError?: (callback: (err: { message?: string }) => void) => (() => void) | void;
}

export interface UpdateStore {
  getSnapshot: () => UpdateSnapshot;
  subscribe: (listener: () => void) => () => void;
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissBanner: () => void;
  dispose: () => void;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

export function shouldShowUpdateBanner(snapshot: UpdateSnapshot): boolean {
  if (snapshot.bannerDismissed) return false;
  return (
    snapshot.status === 'available' ||
    snapshot.status === 'downloading' ||
    snapshot.status === 'downloaded'
  );
}

export function createUpdateStore(bridge?: UpdateBridge | null): UpdateStore {
  let snapshot: UpdateSnapshot = {
    currentVersion: '',
    status: 'idle',
    availableVersion: '',
    progress: 0,
    errorMessage: '',
    bannerDismissed: false,
    isDevBuild: false,
    checkedManually: false,
  };

  const listeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];

  function setState(patch: Partial<UpdateSnapshot>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof UpdateSnapshot>) {
      if (snapshot[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  }

  function registerUnsub(unsub: (() => void) | void): void {
    if (typeof unsub === 'function') {
      unsubscribers.push(unsub);
    }
  }

  if (bridge) {
    if (bridge.getAppVersion) {
      try {
        Promise.resolve(bridge.getAppVersion())
          .then((version) => {
            if (typeof version === 'string' && version) {
              setState({ currentVersion: version });
            }
          })
          .catch(() => {
            // Игнорируем ошибку чтения версии при инициализации.
          });
      } catch {
        // Игнорируем синхронную ошибку чтения версии при инициализации.
      }
    }

    registerUnsub(
      bridge.onUpdateAvailable?.((info) => {
        const version = info?.version || snapshot.availableVersion;
        // Не откатываем активную или завершенную загрузку назад в available
        // и не сбрасываем bannerDismissed в текущей сессии.
        if (snapshot.status === 'downloading' || snapshot.status === 'downloaded') {
          setState({
            availableVersion: version,
            errorMessage: '',
            isDevBuild: false,
          });
          return;
        }
        setState({
          status: 'available',
          availableVersion: version,
          errorMessage: '',
          isDevBuild: false,
        });
      })
    );

    registerUnsub(
      bridge.onUpdateNotAvailable?.(() => {
        if (
          snapshot.status === 'available' ||
          snapshot.status === 'downloading' ||
          snapshot.status === 'downloaded'
        ) {
          return;
        }
        setState({
          status: 'up-to-date',
          errorMessage: '',
          isDevBuild: false,
        });
      })
    );

    registerUnsub(
      bridge.onUpdateProgress?.((progressInfo) => {
        if (snapshot.status === 'downloaded') return;
        const raw =
          typeof progressInfo?.percent === 'number' && Number.isFinite(progressInfo.percent)
            ? progressInfo.percent
            : 0;
        const percent = Math.max(0, Math.min(100, Math.round(raw)));
        setState({
          status: 'downloading',
          progress: percent,
          errorMessage: '',
        });
      })
    );

    registerUnsub(
      bridge.onUpdateDownloaded?.(() => {
        setState({
          status: 'downloaded',
          progress: 100,
          errorMessage: '',
        });
      })
    );

    registerUnsub(
      bridge.onUpdateError?.((err) => {
        // Фоновые ошибки вне активной проверки или загрузки не должны
        // сбивать уже найденное или скачанное обновление.
        if (snapshot.status !== 'checking' && snapshot.status !== 'downloading') {
          return;
        }
        setState({
          status: 'error',
          progress: 0,
          errorMessage: err?.message || 'Update failed',
        });
      })
    );
  }

  async function checkForUpdates(): Promise<void> {
    if (
      snapshot.status === 'checking' ||
      snapshot.status === 'downloading' ||
      snapshot.status === 'downloaded'
    ) {
      return;
    }

    setState({
      status: 'checking',
      checkedManually: true,
      errorMessage: '',
      isDevBuild: false,
    });

    if (!bridge?.checkForUpdates) {
      setState({
        status: 'idle',
        isDevBuild: true,
      });
      return;
    }

    try {
      const result = await bridge.checkForUpdates();
      const statusAfterAwait = getSnapshot().status;
      if (statusAfterAwait === 'downloading' || statusAfterAwait === 'downloaded') {
        if (result?.currentVersion) {
          setState({ currentVersion: result.currentVersion });
        }
        return;
      }

      if (!result) {
        setState({
          status: 'up-to-date',
          errorMessage: '',
          isDevBuild: false,
        });
        return;
      }

      const currentVersion = result.currentVersion || snapshot.currentVersion;
      switch (result.status) {
        case 'available':
          setState({
            currentVersion,
            status: 'available',
            availableVersion: result.version || snapshot.availableVersion,
            errorMessage: '',
            isDevBuild: false,
          });
          break;
        case 'up-to-date':
          setState({
            currentVersion,
            status: 'up-to-date',
            availableVersion: '',
            errorMessage: '',
            isDevBuild: false,
          });
          break;
        case 'dev':
          setState({
            currentVersion,
            status: 'idle',
            errorMessage: '',
            isDevBuild: true,
          });
          break;
        case 'error':
          setState({
            currentVersion,
            status: 'error',
            errorMessage: result.message || 'Failed to check for updates',
            isDevBuild: false,
          });
          break;
      }
    } catch (err) {
      const statusAfterAwait = getSnapshot().status;
      if (statusAfterAwait === 'downloading' || statusAfterAwait === 'downloaded') {
        return;
      }
      setState({
        status: 'error',
        errorMessage: getErrorMessage(err, 'Failed to check for updates'),
      });
    }
  }

  async function downloadUpdate(): Promise<void> {
    if (snapshot.status === 'downloading' || snapshot.status === 'downloaded') {
      return;
    }

    setState({
      status: 'downloading',
      progress: 0,
      errorMessage: '',
    });

    if (!bridge?.downloadUpdate) {
      setState({
        status: 'error',
        progress: 0,
        errorMessage: 'Updater bridge is not available',
      });
      return;
    }

    try {
      await bridge.downloadUpdate();
    } catch (err) {
      if (getSnapshot().status === 'downloaded') return;
      setState({
        status: 'error',
        progress: 0,
        errorMessage: getErrorMessage(err, 'Failed to download update'),
      });
    }
  }

  async function installUpdate(): Promise<void> {
    if (!bridge?.installUpdate) return;
    try {
      await bridge.installUpdate();
    } catch (err) {
      setState({
        status: 'error',
        errorMessage: getErrorMessage(err, 'Failed to install update'),
      });
    }
  }

  function dismissBanner(): void {
    setState({ bannerDismissed: true });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot(): UpdateSnapshot {
    return snapshot;
  }

  function dispose(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    listeners.clear();
  }

  return {
    getSnapshot,
    subscribe,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    dismissBanner,
    dispose,
  };
}

function getWindowBridge(): UpdateBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { bridge?: UpdateBridge }).bridge;
}

export const updateStore = createUpdateStore(getWindowBridge());

export function useUpdateState(): UpdateSnapshot {
  return useSyncExternalStore(
    updateStore.subscribe,
    updateStore.getSnapshot,
    updateStore.getSnapshot
  );
}
