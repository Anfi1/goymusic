import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// Правила из DESIGN.md: цвета, размеры шрифта и скругления в модулях берутся только из токенов theme.css
const cssFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [])

const RULES: [name: string, bad: RegExp][] = [
  ['font-size', /font-size:\s*(?!\s|var\(--fs-|0\b|inherit|clamp\(|4rem)[^;]+/g],
  ['border-radius', /border-radius:\s*[^;]*\d+px[^;]*/g],
  // радужная полоса прогресса: пасхалка, а не цвет интерфейса
  ['hex', /^(?!.*#FF0000).*#[0-9a-fA-F]{3,8}\b.*$/gm],
]

test('в модулях нет значений мимо токенов', () => {
  const found = cssFiles('src').filter(f => !f.endsWith('theme.css')).flatMap(f => {
    // маски и комментарии не цвета интерфейса
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/mask(-image)?:[^;]+;/g, '')
    return RULES.flatMap(([name, bad]) => (css.match(bad) ?? []).map(m => `${f} ${name}: ${m.trim()}`))
  })
  expect(found).toEqual([])
})
