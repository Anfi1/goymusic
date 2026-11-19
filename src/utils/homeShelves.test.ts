import { describe, expect, it } from 'vitest';
import type { YTMHomeSection } from '../api/yt';
import { nextHomeContinuation, orderHomeShelves, shouldSeekHomeShelves } from './homeShelves';

const shelf = (title: string | null, homeRole?: YTMHomeSection['homeRole']): YTMHomeSection => ({
  title, homeRole, contents: [{ id: 'one' }],
});
const page = (...sections: YTMHomeSection[]) => ({ sections });

describe('orderHomeShelves', () => {
  it('promotes the two roles across pages without changing the order or keys of the other shelves', () => {
    const quick = shelf('快速选听', 'quick-picks');
    const listen = shelf('もう一度聴く', 'listen-again');
    const a = shelf('A'), b = shelf('B'), c = shelf('C');
    const initial = page(a, quick, b);
    const before = orderHomeShelves([initial]);
    expect(before.map(row => row.section)).toEqual([quick, a, b]);
    const after = orderHomeShelves([initial, page(c), page(), page(listen)]);
    expect(after.map(row => row.section)).toEqual([listen, quick, a, b, c]);
    expect(after.slice(1, 4).map(row => row.feedIndex)).toEqual(before.map(row => row.feedIndex));
  });

  it('chooses a wire role over a legacy name and keeps all additional matching shelves in place', () => {
    const legacy = shelf('Рекомендуем'), a = shelf('A'), b = shelf('B');
    const listen = shelf('Quick picks', 'listen-again'); // Wire beats the contradictory title.
    const quick = shelf('Q', 'quick-picks'), secondQuick = shelf('Q2', 'quick-picks');
    const secondListen = shelf('L2', 'listen-again');
    const rows = orderHomeShelves([page(legacy, a, listen), page(quick, secondQuick, b, secondListen)]);
    expect(rows.map(row => row.section)).toEqual([listen, quick, legacy, a, secondQuick, b, secondListen]);
  });

  it.each([
    [' Listen again ', 'listen-again'], ['Слушать еще раз', 'listen-again'],
    ['Послушать ещё раз', 'listen-again'], ['Послушайте еще раз', 'listen-again'],
    ['РЕКОМЕНДУЕМ', 'quick-picks'], ['Быстрый выбор', 'quick-picks'], ['Quick picks', 'quick-picks'],
  ])('recognizes the exact legacy label %s', (title, role) => {
    expect(orderHomeShelves([page(shelf('A'), shelf(title))])[0].role).toBe(role);
  });

  it('leaves similar titles, untitled shelves and a feed without either role alone', () => {
    const ordinary = [null, 'Послушать еще раз: рок', 'My quick picks', 'Рекомендуем альбомы'].map(t => shelf(t));
    const rows = orderHomeShelves([page(...ordinary)]);
    expect(rows.map(row => row.section)).toEqual(ordinary);
    expect(rows.every(row => row.role === undefined)).toBe(true);
    expect(orderHomeShelves([])).toEqual([]);
  });

  it('normalizes only Listen again pins and never edits the cached input', () => {
    const contents = [{ isPinned: true }, { isPinned: false }, { isPinned: true }];
    const quick = { ...shelf('Рекомендуем'), contents };
    const listen = { ...shelf('Encore', 'listen-again'), contents };
    expect(orderHomeShelves([page(quick)])[0].section).toBe(quick);
    const [l, q] = orderHomeShelves([page(quick), page(listen)]);
    expect(l.section.contents.map(item => item.isPinned)).toEqual([true, false, false]);
    expect(l.section.contents[0]).toBe(contents[0]);
    expect(q.section.contents).toBe(contents);
    expect(contents[2].isPinned).toBe(true);
  });
});

describe('Home continuation discovery', () => {
  it('seeks an absent role through page four, stops when both arrive, and caps an incomplete feed', () => {
    const first = page(shelf('Listen again')), quick = page(shelf('Quick picks'));
    expect(shouldSeekHomeShelves(0, [])).toBe(false);
    expect(shouldSeekHomeShelves(1, orderHomeShelves([quick]))).toBe(true);
    expect(shouldSeekHomeShelves(3, orderHomeShelves([first, page(), page()]))).toBe(true);
    expect(shouldSeekHomeShelves(4, orderHomeShelves([first, page(), page(), quick]))).toBe(false);
    expect(shouldSeekHomeShelves(4, orderHomeShelves([first]))).toBe(true);
    expect(shouldSeekHomeShelves(5, orderHomeShelves([first]))).toBe(false);
  });

  it('does not request exhausted or previously consumed cursors, including multi-page cycles', () => {
    const requested = [null, 'a', 'b'];
    expect(nextHomeContinuation('c', requested)).toBe('c');
    for (const token of [null, '', 'a', 'b']) expect(nextHomeContinuation(token, requested)).toBeUndefined();
  });
});
