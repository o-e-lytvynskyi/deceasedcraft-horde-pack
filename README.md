# deceasedcraft-horde-pack

Дополнения для сервера DeceasedCraft (MC 1.20.1, Forge 47.4.0).

## Ресурспак: музыка ночи орды

`deceasedcraft-horde-pack.zip` — серверный ресурспак, клиент сам предлагает скачать его при входе.
Внутри два трека (namespace `deceasedhorde`):

| звук | файл |
| --- | --- |
| `deceasedhorde:horde.music.smaragdove_nebo` | `assets/deceasedhorde/sounds/horde/smaragdove_nebo.ogg` |
| `deceasedhorde:horde.music.plyashka_fragolino` | `assets/deceasedhorde/sounds/horde/plyashka_fragolino.ogg` |

Подключение (образ `itzg/minecraft-server`, env StatefulSet):

```yaml
- name: RESOURCE_PACK
  value: "https://raw.githubusercontent.com/o-e-lytvynskyi/deceasedcraft-horde-pack/main/deceasedcraft-horde-pack.zip"
- name: RESOURCE_PACK_SHA1
  value: "<sha1 zip>"
```

При обновлении пака пересобрать zip (`./build.sh`) и обновить `RESOURCE_PACK_SHA1`, иначе клиенты возьмут старую копию из кэша.

## KubeJS-скрипты (`kubejs/server_scripts/functions/`)

- `horde_siren.js` — за 200 тиков до орды тайтл «ОРДА», вой и музыка; треки чередуются, пока у игрока идёт орда,
  и выключаются, когда она кончается. Команды (op): `/hordesiren` — тест себе, `/hordesiren stop`, `/hordesiren status`.
- `apoc_airdrop.js` — авиадропы Apocalypse Now: раз в час онлайна у случайного игрока и по команде
  `/apocairdrop common|military|medical`. Ящик падает в 30–60 блоках и дымит.

Копии лежат на сервере в `/data/kubejs/server_scripts/functions/`, применяются `/reload`.
Откат — удалить файл и `/reload`.
