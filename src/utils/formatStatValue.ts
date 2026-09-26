/** Число из локализованной строки YouTube («1,4 млн прослушиваний» -> 1400000) */
export function parseStatValue(raw: string | null | undefined): number | null {
  if (!raw) return null;

  const UNITS: Record<string, number> = {
    // Русские
    'тыс': 1_000, 'млн': 1_000_000, 'млрд': 1_000_000_000,
    // Английские
    'b': 1_000_000_000, 'm': 1_000_000, 'k': 1_000,
    // Немецкие и прочие
    'mrd': 1_000_000_000, 'mio': 1_000_000,
  };

  // Убираем всё до первой цифры
  const stripped = raw.replace(/^[^\d]*/, '');
  if (!stripped) return null;

  // Ищем единицу измерения в оставшейся строке
  const lower = stripped.toLowerCase();
  let multiplier = 1;
  let numPart = stripped;

  for (const [unit, mult] of Object.entries(UNITS)) {
    const idx = lower.indexOf(unit);
    if (idx > 0) {
      multiplier = mult;
      numPart = stripped.substring(0, idx).trim();
      break;
    }
  }

  // Убираем пробелы/неразрывные пробелы (разделители разрядов)
  numPart = numPart.replace(/[\s\u00a0]/g, '');

  // Определяем десятичный разделитель
  if (numPart.includes(',') && numPart.includes('.')) {
    if (numPart.lastIndexOf(',') > numPart.lastIndexOf('.')) {
      numPart = numPart.replace(/\./g, '').replace(',', '.');
    } else {
      numPart = numPart.replace(/,/g, '');
    }
  } else if (numPart.includes(',')) {
    const parts = numPart.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      numPart = numPart.replace(',', '.');
    } else {
      numPart = numPart.replace(/,/g, '');
    }
  }

  const value = parseFloat(numPart) * multiplier;
  return isNaN(value) ? null : value;
}

/** Парсит локализованное значение и форматирует как короткое число */
export function formatStatValue(raw: string | null | undefined): string {
  if (!raw) return '';
  const value = parseStatValue(raw);
  if (value === null) return raw;

  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000)
      .toFixed(1).replace(/\.0$/, '') + 'B';
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000)
      .toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (value >= 1_000) {
    return (value / 1_000)
      .toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return value.toString();
}
