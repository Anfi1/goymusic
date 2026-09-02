export interface MoodCategory {
  id: string;
  label: string;
  emoji: string;
  keywords: string[];
  color: string;
}

export const MOOD_CATEGORIES: MoodCategory[] = [
  { id: 'all',       label: 'Все',               emoji: '✨', keywords: [],                                                      color: '#89b4fa' },
  { id: 'personal',  label: 'Мой микс',          emoji: '🎵', keywords: ['мой микс', 'my mix'],                                  color: '#89b4fa' },
  { id: 'happy',     label: 'Хорошее настроение', emoji: '😊', keywords: ['хорошего настроен', 'good mood'],                      color: '#a6e3a1' },
  { id: 'sad',       label: 'Грустное',            emoji: '🌧', keywords: ['грустн', 'sad'],                                       color: '#89dceb' },
  { id: 'sleep',     label: 'Сон',                 emoji: '🌙', keywords: ['для сна', 'sleep'],                                    color: '#b4befe' },
  { id: 'chill',     label: 'Отдых',               emoji: '🌊', keywords: ['отдых', 'chill', 'романтич', 'romantic'],              color: '#94e2d5' },
  { id: 'energy',    label: 'Энергия',             emoji: '⚡', keywords: ['фитнес', 'бодрост', 'fitness', 'energy'],             color: '#f9e2af' },
  { id: 'party',     label: 'Вечеринка',           emoji: '🎉', keywords: ['вечеринк', 'party', 'коачелл'],                       color: '#f38ba8' },
  { id: 'focus',     label: 'Концентрация',        emoji: '🎯', keywords: ['концентрац', 'focus'],                                 color: '#fab387' },
  { id: 'throwback', label: 'Ностальгия',          emoji: '📼', keywords: ['архивн', 'риплей', 'replay', 'archiv'],               color: '#cba6f7' },
  { id: 'discovery', label: 'Открытия',            emoji: '✨', keywords: ['рекоменд', 'новых релизов', 'new release', 'discover'], color: '#f5c2e7' },
  { id: 'genre',     label: 'Жанровое',            emoji: '🎸', keywords: [],                                                      color: '#f2cdcd' },
  { id: 'soundcloud',label: 'SoundCloud',          emoji: '☁️', keywords: [],                                                      color: '#ff7700' },
  { id: 'yandex',    label: 'Yandex Music',        emoji: '🟡', keywords: [],                                                      color: '#ffcc00' },
];

export function groupKey(title: string): string {
  return title.trim()
    .replace(/\s+\d+$/, '')
    .replace(/Супермикс/g, 'Микс')
    .replace(/супермикс/g, 'микс')
    .replace(/\s+/g, ' ')
    .trim();
}

export function assignCategory(groupName: string): MoodCategory | null {
  const lower = groupName.toLowerCase();
  // Проверяем все категории кроме 'all' и 'soundcloud'/'genre'/'yandex'
  for (const cat of MOOD_CATEGORIES) {
    if (cat.id === 'all' || cat.id === 'genre' || cat.id === 'soundcloud' || cat.id === 'yandex') continue;
    if (cat.keywords.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

export function getCategoryById(id: string): MoodCategory | undefined {
  return MOOD_CATEGORIES.find(c => c.id === id);
}
