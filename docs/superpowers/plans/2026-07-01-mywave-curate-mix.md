# «Подобрать» (кастомный микс по настроениям) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пользователю собрать в «Моей волне» собственный микс, натыкав несколько тегов-настроений, и получить синтетическую станцию «🎛 Мой подбор» с перемешанным трек-листом.

**Architecture:** Чисто клиентская фича. Чистые функции подбора/смешивания в новом `src/utils/curatedMix.ts` (юнит-тесты Vitest). UI-обвязка в `MyWaveView`: чип «+ Подобрать» → поповер `CuratePanel` с мультивыбором настроений → сборка трек-листа из уже существующих миксов пула (`getPlaylistTracks`) → синтетическая станция, играемая через существующий `startStation`/`player.playTrackList`. Правок Python нет.

**Tech Stack:** React + TypeScript + Vite, Vitest (env `node`), CSS Modules, существующий `player` (`src/api/player.ts`).

## Global Constraints

- Комментарии — только для неочевидной логики, на русском (конвенция проекта).
- Новый код — в стиле окружающих файлов; компоненты по atomic-структуре (`molecules/`).
- Тесты — в `src/**/*.test.ts`, среда `node`, только на чистой логике (React-компоненты не тестируем — jsdom не настроен).
- Правок в `python/` нет. Ветка: `feature/mywave-curate-mix`.
- Существующие сигнатуры (использовать как есть):
  - `interface WaveStation { id: string; title: string; thumbUrl: string; kind: 'foryou'|'sc'|'yt' }` — расширяется на `'curated'`.
  - `WAVE_SOURCE_ID = 'my-wave'`.
  - `getPlaylistTracks(playlistId: string, limit?: number|null): Promise<{ tracks: YTMTrack[], trackCount: number, continuation?: string|null }>`.
  - `player.playTrackList(tracks: YTMTrack[], startIndex=0, sourceId=null, sourceType?, recommendationId=null)`.
  - `interface YTMTrack { id: string; title: string; artists?: string[]; ... }`.
  - `MOOD_CATEGORIES: MoodCategory[]`, `assignCategory(groupName: string): MoodCategory|null`, `groupKey(title: string): string` из `src/utils/moodCategories.ts`.

---

### Task 1: `blendTracks` — round-robin смешивание с дедупом и cap

**Files:**
- Create: `src/utils/curatedMix.ts`
- Test: `src/utils/curatedMix.test.ts`

**Interfaces:**
- Consumes: `YTMTrack` из `../api/yt`.
- Produces: `blendTracks(trackLists: YTMTrack[][], cap?: number): YTMTrack[]` — round-robin по спискам (позиция 0 всех списков, затем позиция 1 и т.д.), дедуп по `id`, ограничение `cap` (по умолчанию 60). Чистая, детерминированная.

- [ ] **Step 1: Написать падающий тест**

Создать `src/utils/curatedMix.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blendTracks } from './curatedMix';
import type { YTMTrack } from '../api/yt';

const t = (id: string): YTMTrack => ({ id, title: id } as YTMTrack);

describe('blendTracks', () => {
  it('перемешивает списки round-robin', () => {
    const a = [t('a1'), t('a2'), t('a3')];
    const b = [t('b1'), t('b2')];
    expect(blendTracks([a, b]).map(x => x.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('дедупит по id', () => {
    const a = [t('x'), t('a2')];
    const b = [t('x'), t('b2')];
    expect(blendTracks([a, b]).map(x => x.id)).toEqual(['x', 'a2', 'b2']);
  });

  it('соблюдает cap', () => {
    const a = Array.from({ length: 100 }, (_, i) => t('a' + i));
    expect(blendTracks([a], 60)).toHaveLength(60);
  });

  it('устойчив к пустым спискам', () => {
    expect(blendTracks([[], []])).toEqual([]);
    expect(blendTracks([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run src/utils/curatedMix.test.ts`
Expected: FAIL — `blendTracks` не экспортируется / модуль не найден.

- [ ] **Step 3: Минимальная реализация**

Создать `src/utils/curatedMix.ts`:

```ts
import type { YTMTrack } from '../api/yt';

/**
 * Round-robin смешивание нескольких трек-листов: берём позицию 0 у всех,
 * затем позицию 1 и т.д. Дедуп по id, обрезка до cap.
 */
export function blendTracks(trackLists: YTMTrack[][], cap = 60): YTMTrack[] {
  const lists = trackLists.filter(l => l.length > 0);
  const out: YTMTrack[] = [];
  const seen = new Set<string>();
  let pos = 0;
  while (out.length < cap) {
    let progressed = false;
    for (const list of lists) {
      if (pos < list.length) {
        progressed = true;
        const track = list[pos];
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          out.push(track);
          if (out.length >= cap) break;
        }
      }
    }
    if (!progressed) break;
    pos++;
  }
  return out;
}
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `npx vitest run src/utils/curatedMix.test.ts`
Expected: PASS (4 теста).

- [ ] **Step 5: Коммит**

```bash
git add src/utils/curatedMix.ts src/utils/curatedMix.test.ts
git commit -m "feat(mywave): blendTracks — round-robin смешивание треков"
```

---

### Task 2: `pickMixesForMoods` + `moodTagCategories`

**Files:**
- Modify: `src/utils/curatedMix.ts`
- Test: `src/utils/curatedMix.test.ts`

**Interfaces:**
- Consumes: `MoodCategory`, `MOOD_CATEGORIES`, `assignCategory`, `groupKey` из `./moodCategories`.
- Produces:
  - `moodTagCategories(): MoodCategory[]` — категории для панели (без `all`/`genre`/`soundcloud`).
  - `pickMixesForMoods<T extends { title: string; kind: string }>(moodIds: string[], stations: T[]): Record<string, T[]>` — для каждого настроения его YT-миксы (`kind==='yt'`, классифицированные через `assignCategory(groupKey(title))`).

- [ ] **Step 1: Написать падающий тест**

Добавить в `src/utils/curatedMix.test.ts`:

```ts
import { pickMixesForMoods, moodTagCategories } from './curatedMix';

describe('moodTagCategories', () => {
  it('исключает all/genre/soundcloud', () => {
    const ids = moodTagCategories().map(c => c.id);
    expect(ids).not.toContain('all');
    expect(ids).not.toContain('genre');
    expect(ids).not.toContain('soundcloud');
    expect(ids).toContain('energy');
  });
});

describe('pickMixesForMoods', () => {
  const st = (title: string, kind = 'yt') => ({ id: title, title, kind });
  it('группирует yt-станции по настроениям', () => {
    const stations = [
      st('Заряд бодрости 1'),        // energy (keyword 'бодрост')
      st('Для отличного настроения'), // happy (keyword 'хорошего настроен'? нет) -> проверяем вечеринку
      st('Вечеринка века'),           // party (keyword 'вечеринк')
    ];
    const res = pickMixesForMoods(['energy', 'party'], stations);
    expect(res.energy.map(s => s.title)).toEqual(['Заряд бодрости 1']);
    expect(res.party.map(s => s.title)).toEqual(['Вечеринка века']);
  });
  it('игнорирует не-yt станции', () => {
    const res = pickMixesForMoods(['party'], [st('Вечеринка', 'sc')]);
    expect(res.party).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run src/utils/curatedMix.test.ts`
Expected: FAIL — `pickMixesForMoods`/`moodTagCategories` не определены.

- [ ] **Step 3: Реализация**

Добавить в начало `src/utils/curatedMix.ts` (импорт) и функции:

```ts
import { MOOD_CATEGORIES, assignCategory, groupKey, type MoodCategory } from './moodCategories';

/** Категории-настроения для панели «Подобрать» (без служебных all/genre/soundcloud). */
export function moodTagCategories(): MoodCategory[] {
  return MOOD_CATEGORIES.filter(c => c.id !== 'all' && c.id !== 'genre' && c.id !== 'soundcloud');
}

/** Для каждого выбранного настроения — его YT-миксы из пула станций. */
export function pickMixesForMoods<T extends { title: string; kind: string }>(
  moodIds: string[],
  stations: T[],
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const id of moodIds) result[id] = [];
  for (const st of stations) {
    if (st.kind !== 'yt') continue;
    const cat = assignCategory(groupKey(st.title));
    if (cat && result[cat.id]) result[cat.id].push(st);
  }
  return result;
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run src/utils/curatedMix.test.ts`
Expected: PASS (все тесты). Если тест на конкретное настроение не сходится с ключевыми словами `MOOD_CATEGORIES` — поправить названия станций в тесте под реальные `keywords` из `src/utils/moodCategories.ts`, не трогая продакшн-логику.

- [ ] **Step 5: Коммит**

```bash
git add src/utils/curatedMix.ts src/utils/curatedMix.test.ts
git commit -m "feat(mywave): pickMixesForMoods + moodTagCategories"
```

---

### Task 3: Синтетическая станция CURATED + ветка воспроизведения

**Files:**
- Modify: `src/components/organisms/MyWaveView.tsx`

**Interfaces:**
- Consumes: `blendTracks`, `pickMixesForMoods` из `../../utils/curatedMix`; `getPlaylistTracks` из `../../api/yt`.
- Produces (в пределах компонента): состояние `curatedTracks`, `curatedMoods`, `curateBuilding`; функция `buildCuratedMix(moodIds: string[])`; константа `CURATED: WaveStation`; ветка `startStation` для `kind==='curated'`.

- [ ] **Step 1: Расширить тип и добавить константы**

В `src/components/organisms/MyWaveView.tsx`:

Изменить строку 25:
```ts
interface WaveStation { id: string; title: string; thumbUrl: string; kind: 'foryou' | 'sc' | 'yt' | 'curated'; }
```

Рядом с `FORYOU` (после строки 26) добавить:
```ts
const CURATED: WaveStation = { id: 'curated', title: 'Мой подбор', thumbUrl: '', kind: 'curated' };
const WAVE_CURATED_MOODS_KEY = 'ytm-curated-moods';

function getSavedCuratedMoods(): string[] {
  try {
    const raw = localStorage.getItem(WAVE_CURATED_MOODS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function saveCuratedMoods(ids: string[]) {
  try { localStorage.setItem(WAVE_CURATED_MOODS_KEY, JSON.stringify(ids)); } catch {}
}
```

- [ ] **Step 2: Добавить импорт и состояние**

Добавить в импорт из `../../api/yt` (строка 7) при необходимости уже есть `getPlaylistTracks`. Добавить новый импорт после строки 19:
```ts
import { blendTracks, pickMixesForMoods, moodTagCategories } from '../../utils/curatedMix';
```

Рядом с остальными `useState` (после строки 170) добавить:
```ts
  const [curateOpen, setCurateOpen] = useState(false);
  const [curatedMoods, setCuratedMoods] = useState<string[]>(getSavedCuratedMoods());
  const [curatedTracks, setCuratedTracks] = useState<YTMTrack[]>([]);
  const [curateBuilding, setCurateBuilding] = useState(false);
```

- [ ] **Step 3: Добавить ветку в `startStation` для CURATED**

В `startStation` (строка 390), первым условием внутри `try` (перед существующей обработкой `foryou`/`sc`/`yt`) добавить:
```ts
      if (st.kind === 'curated') {
        if (curatedTracks.length === 0) { setError('Сначала собери микс в «Подобрать».'); return; }
        await player.playTrackList(curatedTracks, 0, WAVE_SOURCE_ID);
        return;
      }
```
Добавить `curatedTracks` в массив зависимостей `useCallback` этого `startStation`.

- [ ] **Step 4: Добавить `buildCuratedMix`**

После `startStation` добавить:
```ts
  // Собираем кастомный микс: миксы выбранных настроений -> треки -> round-robin.
  const buildCuratedMix = useCallback(async (moodIds: string[]) => {
    if (moodIds.length === 0) return;
    setCurateBuilding(true);
    setError(null);
    try {
      const groups = pickMixesForMoods(moodIds, stations);
      const chosen: WaveStation[] = [];
      for (const id of moodIds) chosen.push(...(groups[id] || []).slice(0, 2)); // 1–2 микса на настроение
      if (chosen.length === 0) { setError('Нет миксов под эти настроения.'); return; }

      const settled = await Promise.allSettled(chosen.map(m => getPlaylistTracks(m.id, 30)));
      const lists: YTMTrack[][] = settled
        .map(r => (r.status === 'fulfilled' ? (r.value.tracks || []) : []))
        .map(shuffle)                       // лёгкая вариативность между сборками
        .filter(l => l.length > 0);
      const blended = blendTracks(lists, 60);
      if (blended.length === 0) { setError('Не удалось собрать микс, попробуй другие настроения.'); return; }

      setCuratedTracks(blended);
      saveCuratedMoods(moodIds);
      setCurateOpen(false);
      await startStation(CURATED);
    } finally {
      setCurateBuilding(false);
    }
  }, [stations, startStation]);
```

Добавить утилиту `shuffle` рядом с другими файловыми хелперами (после строки 41):
```ts
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

- [ ] **Step 5: Проверка типов**

Run: `npx tsc --noEmit`
Expected: без ошибок. (Функция `buildCuratedMix` пока не вызывается — это нормально; следующий таск подключит UI. Если линтер ругается на неиспользуемое — временно допустимо, UI-таск устранит.)

- [ ] **Step 6: Коммит**

```bash
git add src/components/organisms/MyWaveView.tsx
git commit -m "feat(mywave): станция CURATED, buildCuratedMix, воспроизведение подбора"
```

---

### Task 4: Панель `CuratePanel` (мультивыбор настроений)

**Files:**
- Create: `src/components/molecules/CuratePanel.tsx`
- Create: `src/components/molecules/CuratePanel.module.css`

**Interfaces:**
- Consumes: `moodTagCategories` из `../../utils/curatedMix`.
- Produces: `<CuratePanel selected onToggle onBuild building onClose />` со свойствами:
  `selected: string[]`, `onToggle: (id: string) => void`, `onBuild: () => void`, `building: boolean`, `onClose: () => void`.

- [ ] **Step 1: Создать компонент**

`src/components/molecules/CuratePanel.tsx`:
```tsx
import React from 'react';
import { Loader2, Check } from 'lucide-react';
import { moodTagCategories } from '../../utils/curatedMix';
import styles from './CuratePanel.module.css';

interface CuratePanelProps {
  selected: string[];
  onToggle: (id: string) => void;
  onBuild: () => void;
  building: boolean;
  onClose: () => void;
}

export const CuratePanel: React.FC<CuratePanelProps> = ({ selected, onToggle, onBuild, building, onClose }) => {
  const cats = moodTagCategories();
  return (
    <div className={styles.panel} role="dialog" aria-label="Подбор настроений">
      <div className={styles.list}>
        {cats.map(cat => {
          const on = selected.includes(cat.id);
          return (
            <button
              key={cat.id}
              type="button"
              className={`${styles.row} ${on ? styles.rowOn : ''}`}
              style={{ '--mood-color': cat.color } as React.CSSProperties}
              onClick={() => onToggle(cat.id)}
            >
              <span className={styles.check}>{on && <Check size={13} />}</span>
              <span className={styles.emoji}>{cat.emoji}</span>
              <span className={styles.label}>{cat.label}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.footer}>
        <button type="button" className={styles.cancel} onClick={onClose} disabled={building}>Отмена</button>
        <button
          type="button"
          className={styles.build}
          onClick={onBuild}
          disabled={selected.length === 0 || building}
        >
          {building ? <Loader2 size={15} className={styles.spin} /> : `Собрать микс${selected.length ? ` (${selected.length})` : ''}`}
        </button>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Создать стили**

`src/components/molecules/CuratePanel.module.css`:
```css
.panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 12px;
  z-index: 20;
  width: 240px;
  padding: 8px;
  border-radius: 14px;
  background: rgba(18, 18, 22, 0.96);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
}
.list { display: flex; flex-direction: column; gap: 2px; max-height: 280px; overflow-y: auto; }
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border: none; border-radius: 10px;
  background: transparent; color: var(--text-secondary);
  cursor: pointer; text-align: left; font-size: 13px;
  transition: background 0.14s ease, color 0.14s ease;
}
.row:hover { background: rgba(255, 255, 255, 0.05); color: #fff; }
.rowOn { color: #fff; background: color-mix(in srgb, var(--mood-color) 18%, transparent); }
.check {
  width: 18px; height: 18px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.25);
  color: var(--mood-color);
}
.rowOn .check { border-color: var(--mood-color); background: color-mix(in srgb, var(--mood-color) 30%, transparent); }
.emoji { font-size: 14px; }
.label { white-space: nowrap; }
.footer { display: flex; gap: 8px; margin-top: 8px; }
.cancel, .build {
  flex: 1; padding: 9px; border: none; border-radius: 10px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.cancel { background: rgba(255, 255, 255, 0.06); color: var(--text-secondary); }
.build { background: linear-gradient(135deg, #7c3aed, #ec4899 90%); color: #fff; }
.build:disabled { opacity: 0.5; cursor: default; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: Проверка типов**

Run: `npx tsc --noEmit`
Expected: без ошибок.

- [ ] **Step 4: Коммит**

```bash
git add src/components/molecules/CuratePanel.tsx src/components/molecules/CuratePanel.module.css
git commit -m "feat(mywave): компонент CuratePanel (мультивыбор настроений)"
```

---

### Task 5: Чип «+ Подобрать», станция в колесе, подзаголовок

**Files:**
- Modify: `src/components/organisms/MyWaveView.tsx`
- Modify: `src/components/organisms/MyWaveView.module.css`

**Interfaces:**
- Consumes: `CuratePanel` из `../molecules/CuratePanel`; состояние/функции из Task 3.

- [ ] **Step 1: Импорт панели**

В `MyWaveView.tsx` после импорта `QueuePanel` (строка 18):
```ts
import { CuratePanel } from '../molecules/CuratePanel';
```

- [ ] **Step 2: Чип и панель в ленте фильтров**

В `filterStrip` (JSX ~строка 517), сразу ПОСЛЕ закрывающего `</div>` списка `filterList` (после строки 544) и до правой стрелки, добавить обёртку с чипом и панелью. Чип рендерим отдельной кнопкой, панель — условно:
```tsx
          <div className={styles.curateWrap}>
            <button
              type="button"
              className={`${styles.curateChip} ${curateOpen ? styles.curateChipOn : ''}`}
              onClick={() => setCurateOpen(v => !v)}
              title="Собрать свой микс по настроениям"
            >
              + Подобрать
            </button>
            {curateOpen && (
              <CuratePanel
                selected={curatedMoods}
                onToggle={(id) => setCuratedMoods(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                onBuild={() => buildCuratedMix(curatedMoods)}
                building={curateBuilding}
                onClose={() => setCurateOpen(false)}
              />
            )}
          </div>
```

- [ ] **Step 3: Показ станции CURATED в колесе**

В рендере колеса (`looped.map(...)`, ~строка 552) добавить: когда есть собранный микс, показывать станцию CURATED первой. Проще всего — включить её в список станций для отображения. Найти, где формируется список для колеса (`allStations`/`looped`, ~строки 267–269) и добавить CURATED в начало, если есть треки:

Заменить (строка 267):
```ts
  const allStations = visibleStations;
```
на:
```ts
  const allStations = useMemo<WaveStation[]>(
    () => (curatedTracks.length > 0 ? [CURATED, ...visibleStations] : visibleStations),
    [curatedTracks.length, visibleStations],
  );
```

- [ ] **Step 4: Подзаголовок станции CURATED**

В `renderStation` (строка 474), в блоке `stationKind` (строка 499) учесть `curated`. Заменить выражение вида `st.kind === 'foryou' ? 'Персональная' : st.kind === 'sc' ? 'SoundCloud' : 'YouTube Mix'` на версию с подписью подбора:
```tsx
          <span className={styles.stationKind}>{
            st.kind === 'curated'
              ? `Подбор: ${curatedMoods.map(id => moodTagCategories().find(c => c.id === id)?.label).filter(Boolean).join(', ')}`
              : st.kind === 'foryou' ? 'Персональная'
              : st.kind === 'sc' ? 'SoundCloud'
              : 'YouTube Mix'
          }</span>
```
Для иконки/обложки CURATED (строка 486–488, блок `stationThumb`): для `st.kind === 'curated'` показывать иконку вместо `LazyImage`. Заменить условие `st.kind === 'foryou' ? <иконка> : <LazyImage .../>` на:
```tsx
          {st.kind === 'foryou' || st.kind === 'curated'
            ? <span className={styles.forYouIcon}><AudioLines size={20} /></span>
            : <LazyImage src={st.thumbUrl} alt={st.title} className={styles.stationThumbImg} />}
```

- [ ] **Step 5: Стили чипа**

В `src/components/organisms/MyWaveView.module.css` добавить (рядом с `.filterPill`, ~строка 80):
```css
.curateWrap { position: relative; flex-shrink: 0; margin-right: 6px; align-self: center; }
.curateChip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 7px 12px; border-radius: 999px; white-space: nowrap;
  border: 1px dashed rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.04); color: var(--text-secondary);
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.curateChip:hover { color: #fff; border-color: rgba(255, 255, 255, 0.4); background: rgba(255, 255, 255, 0.08); }
.curateChipOn { color: #fff; border-style: solid; border-color: #a855f7; background: color-mix(in srgb, #a855f7 18%, transparent); }
```

- [ ] **Step 6: Проверка типов и сборка**

Run: `npx tsc --noEmit && npm run build`
Expected: успешная сборка без ошибок TS.

- [ ] **Step 7: Ручная проверка**

Run: `npm run dev`
Проверить в «Моей волне»:
1. Чип «+ Подобрать» виден в ленте фильтров, кликается, открывает/закрывает панель.
2. В панели тыкаются несколько настроений (галочки), «Собрать микс (N)» активна при ≥1.
3. «Собрать микс» → станция «🎛 Мой подбор» появляется первой в колесе, играет; очередь — перемешанные треки выбранных настроений.
4. Перезаход в раздел: сохранённый выбор настроений подхватывается (`ytm-curated-moods`), повторная сборка работает.
5. Настроения без миксов → тост «Нет миксов под эти настроения». «Все» и обычные станции работают как раньше.

- [ ] **Step 8: Коммит**

```bash
git add src/components/organisms/MyWaveView.tsx src/components/organisms/MyWaveView.module.css
git commit -m "feat(mywave): чип «Подобрать», станция подбора в колесе"
```

---

## Self-Review

- **Покрытие спеки:** §3 поток данных → Task 3/5; §4.1 util → Task 1/2; §4.2 MyWaveView-обвязка → Task 3/5; §4.3 CuratePanel/чип → Task 4/5; §5 localStorage `ytm-curated-moods` → Task 3 (save) + Task 5 (restore через init state); §6 крайние случаи (0 настроений, нет миксов, частичный фейл через `allSettled`, дедуп, cap) → Task 3/4; §7 unit-тесты → Task 1/2, ручная проверка → Task 5.
- **Плейсхолдеры:** нет — весь код приведён.
- **Согласованность типов:** `blendTracks`, `pickMixesForMoods`, `moodTagCategories`, `CURATED`, `buildCuratedMix`, `curatedTracks`, `curatedMoods`, `WAVE_CURATED_MOODS_KEY` используются согласованно между тасками.
- **Примечание для реализатора:** точные номера строк в `MyWaveView.tsx` могут отличаться — ориентироваться на имена (`startStation`, `renderStation`, `filterStrip`, `allStations`), а не на номера. Перед правкой прочитать соответствующий фрагмент.
