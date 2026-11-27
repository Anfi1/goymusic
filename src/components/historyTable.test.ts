import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readCss(relPath: string): string {
  const raw = readFileSync(resolve(process.cwd(), relPath), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('HistoryView table row styling', () => {
  it('keeps Played td at full opacity so Deck hover/active background matches sibling cells', () => {
    const css = readCss('src/components/organisms/HistoryView.module.css');
    const timeCellRule = css.match(/\.timeCell\s*\{[^}]*\}/);

    expect(timeCellRule).not.toBeNull();
    expect(timeCellRule![0]).not.toMatch(/\bopacity\s*:/);
    expect(css).toMatch(/:root\[data-layout="deck"\]\s+\.timeCell\s*\{[^}]*color:\s*var\(--text-sub\)/);
  });

  it('renders straight rows in Deck layout matching album tracklists', () => {
    const css = readCss('src/components/organisms/HistoryView.module.css');

    expect(css).toMatch(
      /:root\[data-layout="deck"\]\s+\.table\s*\{[^}]*border-collapse:\s*separate;[^}]*border-spacing:\s*0;/
    );
    expect(css).toMatch(
      /:root\[data-layout="deck"\]\s+\.table\s+tr\[data-index\],\s*:root\[data-layout="deck"\]\s+\.table\s+tr\[data-index\]\s*>\s*td\s*\{[^}]*border-radius:\s*0;/
    );
  });
});
