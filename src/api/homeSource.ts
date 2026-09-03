// Общий персистентный переключатель "откуда Главная/Новые релизы/Коллекции" --
// один флаг на все три экрана, а не три независимых состояния компонентов.
export type HomeSource = 'youtube' | 'yandex';

const KEY = 'ytm-home-source';

export function getHomeSource(): HomeSource {
  return localStorage.getItem(KEY) === 'yandex' ? 'yandex' : 'youtube';
}

export function setHomeSource(value: HomeSource): void {
  localStorage.setItem(KEY, value);
  window.dispatchEvent(new CustomEvent('home-source-changed', { detail: { source: value } }));
}
