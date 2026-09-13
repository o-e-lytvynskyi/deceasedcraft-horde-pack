#!/usr/bin/env bash
# Собрать серверный ресурспак и напечатать sha1 для RESOURCE_PACK_SHA1.
set -euo pipefail
cd "$(dirname "$0")"
rm -f deceasedcraft-horde-pack.zip
# -X: без macOS-метаданных, иначе клиент может ругаться на мусорные файлы
zip -X -r -q deceasedcraft-horde-pack.zip pack.mcmeta assets -x '*.DS_Store'
shasum -a 1 deceasedcraft-horde-pack.zip | cut -d' ' -f1
