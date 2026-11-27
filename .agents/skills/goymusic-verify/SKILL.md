---
name: goymusic-verify
description: >-
  Run the full GoyMusic verification suite (Vitest, TypeScript and Vite production build,
  bundled Python unit tests, offline loudness/lyrics selfchecks, and packaged backend/Android
  contract checks) on Windows PowerShell before committing or releasing.
---

# GoyMusic Verification Runbook

Выполнять из корня активного репозитория или worktree на Windows PowerShell.

## 1. Frontend, Electron и CSS-токены

```powershell
npm test
if ($LASTEXITCODE -eq 0) { npm run build }
```

Проверяет все Vitest-тесты (`src/**/*.test.ts`, включая `src/styles/tokens.test.ts` и `dedupPerf.test.ts`), строгий `tsc` и сборку `dist/` + `dist-electron/`.

## 2. Python-тесты и контрактные проверки (через bundled Python)

Всегда использовать `.\python\bin\python.exe` (не системный `python`):

```powershell
Push-Location python
.\bin\python.exe -m unittest test_backend_contract test_liked_songs test_home_sections test_youtube_channel -v
Pop-Location
if ($LASTEXITCODE -eq 0) {
  .\python\bin\python.exe .github\workflows\check-mobile-host.py
}
if ($LASTEXITCODE -eq 0) {
  .\python\bin\python.exe .github\workflows\check-backend.py .\python\bin\python.exe .\python\api.py
}
```

> Важно: `check-backend.py` требует явные аргументы `<python_exe> <api_py>`.

## 3. Офлайн selfcheck при правках громкости или текстов

```powershell
.\python\bin\python.exe python\test_loudness.py --selfcheck
.\python\bin\python.exe python\test_lyrics.py --selfcheck
```

## 4. Проверка состояния Git перед коммитом/пушем

- Для поиска по коду в `.worktrees/*` использовать `git grep` (не `rg`).
- Перед ребейзом или пушем выполнить `git fetch origin`: `deps-watch.yml` может добавить бот-коммит `chore: bump version to ...` в `origin/main`.
