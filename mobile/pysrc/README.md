# Сгенерированный каталог

Копия `python/fork/ytmusicapi` (форк, который проект использует вместо ставящегося
из pip). Нужна отдельным каталогом потому, что Chaquopy не переваривает вложенные
`srcDirs`: `python` и `python/fork` дают в AssetFinder конфликтующие пути, и импорт
падает `FileNotFoundError: .../AssetFinder/python`.

Пересоздаётся командой `npm run pysrc` в `mobile/`.
