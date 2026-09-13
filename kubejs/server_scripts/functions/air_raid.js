// priority: 0
console.info('Loaded air_raid.js')

// Авианалёты: ковёр из TNT 3 × 10 с шагом 5 блоков. За 30 с до сброса — предупреждение пилота в общий чат
// с координатами и курсом. Источники: случайно (у случайного игрока рядом или прямо по его координатам),
// рация авиаудара (apocalypsenow:military_radio с NBT airstrike:1b — ПКМ в воздух) и команды оператора.
// База под защитой: ни одна бомба не падает в прямоугольник базы + 15 блоков.
//
// Координаты игрока берём через `data get entity` (runCommandSilent возвращает результат команды):
// в этом Rhino player.x = NaN, getUUID() не маппится, Math.PI нет, const внутри функций падает.
// Откат: удалить файл и /reload.

// База: X 233..343, Z 3594..3672, плюс 15 блоков
const RAID_BASE_BUFFER = 15
const RAID_BASE = { minX: 233 - RAID_BASE_BUFFER, maxX: 343 + RAID_BASE_BUFFER, minZ: 3594 - RAID_BASE_BUFFER, maxZ: 3672 + RAID_BASE_BUFFER }

const RAID_ROWS = 10               // TNT вдоль курса
const RAID_COLS = 3                // TNT в ряд поперёк курса
const RAID_SPACING = 5             // шаг между TNT, блоков
const RAID_WARN_TICKS = 600        // предупреждение за 30 с
const RAID_ROW_TICKS = 4           // интервал между рядами — «самолёт летит»
const RAID_DROP_HEIGHT = 25        // бомбы появляются над поверхностью
const RAID_FUSE = 55               // тиков до взрыва (падение с 25 блоков ~45 тиков)

// Случайные налёты: раз в минуту онлайна шанс 1/90 — в среднем раз в полтора часа.
// Шанс «без памяти», поэтому reload/рестарт не сбивают частоту.
const RAID_RANDOM_ENABLED = true
const RAID_RANDOM_CHANCE_PER_MIN = 1 / 90
const RAID_ON_PLAYER_SHARE = 0.5   // доля налётов прямо по координатам игрока (остальное — рядом, 40–100 блоков)
const RAID_RADIO_DISTANCE = 50     // рация: цель в 50 блоках по взгляду
const RAID_RADIO_COOLDOWN = 1200   // рация: не чаще раза в минуту на игрока

const RAID_CALLSIGNS = ['Стервятник-1', 'Стервятник-2', 'Гроза', 'Жнец', 'Молот', 'Ворон-3', 'Каратель']
// Курс: индекс 0..7 = С, СВ, В, ЮВ, Ю, ЮЗ, З, СЗ (-Z север, +X восток)
const RAID_HEADINGS = [
	{ to: 'север', from: 'юга', dx: 0, dz: -1 },
	{ to: 'северо-восток', from: 'юго-запада', dx: 0.7071, dz: -0.7071 },
	{ to: 'восток', from: 'запада', dx: 1, dz: 0 },
	{ to: 'юго-восток', from: 'северо-запада', dx: 0.7071, dz: 0.7071 },
	{ to: 'юг', from: 'севера', dx: 0, dz: 1 },
	{ to: 'юго-запад', from: 'северо-востока', dx: -0.7071, dz: 0.7071 },
	{ to: 'запад', from: 'востока', dx: -1, dz: 0 },
	{ to: 'северо-запад', from: 'юго-востока', dx: -0.7071, dz: -0.7071 }
]

let raidTicks = 0
let raidQueue = []                 // { at: raidTicks, cmd }
let raidRadioUsed = {}             // ник -> raidTicks последнего вызова

function raidOnlineOverworld(srv, name) {
	return srv.runCommandSilent(`execute as ${name} at @s if dimension minecraft:overworld`) > 0
}

function raidPlayerPos(srv, name) {
	return {
		x: srv.runCommandSilent(`data get entity ${name} Pos[0]`),
		z: srv.runCommandSilent(`data get entity ${name} Pos[2]`)
	}
}

// Yaw игрока -> ближайший из 8 курсов. MC: yaw 0 = юг, 90 = запад, 180 = север, -90 = восток.
function raidHeadingFromYaw(yaw) {
	let deg = ((yaw % 360) + 360) % 360
	let byYaw = [4, 5, 6, 7, 0, 1, 2, 3]   // сектор yaw (0,45,90,...) -> индекс курса
	return byYaw[Math.round(deg / 45) % 8]
}

// Все точки сброса: центр ковра в (cx, cz), курс heading
function raidBombs(cx, cz, heading) {
	let h = RAID_HEADINGS[heading]
	// поперечный вектор — поворот курса на 90°
	let px = -h.dz, pz = h.dx
	let bombs = []
	for (let row = 0; row < RAID_ROWS; row++) {
		let along = (row - (RAID_ROWS - 1) / 2) * RAID_SPACING
		for (let col = 0; col < RAID_COLS; col++) {
			let across = (col - (RAID_COLS - 1) / 2) * RAID_SPACING
			bombs.push({ row: row, x: Math.round(cx + h.dx * along + px * across), z: Math.round(cz + h.dz * along + pz * across) })
		}
	}
	return bombs
}

function raidHitsBase(bombs) {
	return bombs.some(b => b.x >= RAID_BASE.minX && b.x <= RAID_BASE.maxX && b.z >= RAID_BASE.minZ && b.z <= RAID_BASE.maxZ)
}

function raidTell(srv, text, color) {
	srv.runCommandSilent(`tellraw @a {"text":"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}","color":"${color}"}`)
}

// Запланировать налёт. Возвращает false, если ковёр задевает базу (ничего не планируется).
function raidSchedule(srv, cx, cz, heading, reason) {
	let bombs = raidBombs(cx, cz, heading)
	if (raidHitsBase(bombs)) return false
	let h = RAID_HEADINGS[heading]
	let call = RAID_CALLSIGNS[Math.floor(Math.random() * RAID_CALLSIGNS.length) % RAID_CALLSIGNS.length]
	raidTell(srv, `✈ [Пилот «${call}»] Цель: X ${cx}, Z ${cz}${reason ? ' (' + reason + ')' : ''}. Захожу с ${h.from}, курс на ${h.to}. Сброс через 30 секунд. Кто внизу — вы покойники.`, 'gold')
	console.info(`air_raid: target ${cx} ${cz} heading ${h.to} reason=${reason || '-'}`)

	let start = raidTicks + RAID_WARN_TICKS
	raidQueue.push({ at: start, cmd: `tellraw @a {"text":"✈ [Пилот «${call}»] Бомбы пошли!","color":"red","bold":true}` })
	raidQueue.push({ at: start, cmd: `execute positioned ${cx} 0 ${cz} positioned over motion_blocking_no_leaves run playsound minecraft:entity.phantom.swoop hostile @a[distance=..160] ~ ~40 ~ 4 0.5` })
	bombs.forEach(b => {
		raidQueue.push({
			at: start + b.row * RAID_ROW_TICKS,
			cmd: `execute positioned ${b.x}.5 0 ${b.z}.5 positioned over motion_blocking_no_leaves run summon minecraft:tnt ~ ~${RAID_DROP_HEIGHT} ~ {Fuse:${RAID_FUSE}s}`
		})
	})
	return true
}

// Налёт рядом с игроком: до 12 попыток найти место и курс вне базы
function raidNearPlayer(srv, name) {
	let pos = raidPlayerPos(srv, name)
	for (let i = 0; i < 12; i++) {
		let a = Math.random() * 6.283185307179586
		let r = 40 + Math.random() * 60
		let cx = Math.round(pos.x + Math.cos(a) * r)
		let cz = Math.round(pos.z + Math.sin(a) * r)
		if (raidSchedule(srv, cx, cz, Math.floor(Math.random() * 8) % 8, null)) return true
	}
	return false
}

// Налёт прямо по координатам игрока: перебираем курсы, пока ковёр не заденет базу
function raidOnPlayer(srv, name) {
	let pos = raidPlayerPos(srv, name)
	let first = Math.floor(Math.random() * 8) % 8
	for (let i = 0; i < 8; i++) {
		if (raidSchedule(srv, pos.x, pos.z, (first + i) % 8, 'сигнал ' + name)) return true
	}
	return false
}

// Рация/команда: цель в RAID_RADIO_DISTANCE блоках по взгляду, курс — по взгляду
function raidAhead(srv, name) {
	let pos = raidPlayerPos(srv, name)
	let heading = raidHeadingFromYaw(srv.runCommandSilent(`data get entity ${name} Rotation[0]`))
	let h = RAID_HEADINGS[heading]
	let cx = Math.round(pos.x + h.dx * RAID_RADIO_DISTANCE)
	let cz = Math.round(pos.z + h.dz * RAID_RADIO_DISTANCE)
	return raidSchedule(srv, cx, cz, heading, 'вызов ' + name)
}

// Предпросмотр без TNT: расчёт — только вызвавшему, точки сброса — столбы дыма на 10 с
function raidPreview(srv, name) {
	let pos = raidPlayerPos(srv, name)
	let heading = raidHeadingFromYaw(srv.runCommandSilent(`data get entity ${name} Rotation[0]`))
	let h = RAID_HEADINGS[heading]
	let cx = Math.round(pos.x + h.dx * RAID_RADIO_DISTANCE)
	let cz = Math.round(pos.z + h.dz * RAID_RADIO_DISTANCE)
	let bombs = raidBombs(cx, cz, heading)
	let hits = raidHitsBase(bombs)
	let msg = `air_raid preview: ты X ${pos.x} Z ${pos.z}, цель X ${cx} Z ${cz}, курс на ${h.to}, бомб ${bombs.length}, задевает базу: ${hits ? 'ДА — налёт был бы отменён' : 'нет'}`
	console.info(msg)
	srv.runCommandSilent(`tellraw ${name} {"text":"${msg}","color":"gray"}`)
	for (let t = 0; t < 10; t++) {
		bombs.forEach(b => {
			raidQueue.push({ at: raidTicks + t * 20, cmd: `execute positioned ${b.x}.5 0 ${b.z}.5 positioned over motion_blocking_no_leaves run particle minecraft:campfire_signal_smoke ~ ~1 ~ 0.2 3 0.2 0.01 6 force` })
		})
	}
}

function raidRandom(srv) {
	let names = []
	srv.players.forEach(p => { if (raidOnlineOverworld(srv, p.username)) names.push(p.username) })
	if (names.length == 0) return false
	let name = names[Math.floor(Math.random() * names.length) % names.length]
	if (Math.random() < RAID_ON_PLAYER_SHARE && raidOnPlayer(srv, name)) return true
	return raidNearPlayer(srv, name)
}

function raidGiveRadio(srv, name) {
	srv.runCommandSilent(`give ${name} apocalypsenow:military_radio{airstrike:1b,display:{Name:'{"text":"Рация авиаудара","color":"red","italic":false}',Lore:['{"text":"ПКМ в воздух — авиаудар в 50 блоках по взгляду","color":"gray","italic":false}','{"text":"Через 30 секунд. Базу не бомбят.","color":"dark_gray","italic":false}']}} 1`)
}

// Рация авиаудара = military_radio с NBT airstrike. item.nbt в Rhino — обёртка CompoundTag (NativeJavaMap),
// её String() не равен SNBT, поэтому проверяем несколькими способами.
function raidIsRadio(item) {
	if (item == null || String(item.id) != 'apocalypsenow:military_radio') return false
	let nbt = item.nbt
	if (nbt == null) return false
	try { if (nbt.airstrike) return true } catch (e) { }
	try { if (nbt.contains && nbt.contains('airstrike')) return true } catch (e) { }
	return String(nbt).indexOf('airstrike') >= 0
}

function raidDescribeItem(item) {
	let nbt = item == null ? null : item.nbt
	let parts = [`id=${item == null ? null : item.id}`, `nbtType=${typeof nbt}`, `nbtStr=${String(nbt)}`]
	try { parts.push(`nbt.airstrike=${nbt.airstrike}`) } catch (e) { parts.push('nbt.airstrike ERR ' + e) }
	try { parts.push(`contains=${nbt.contains('airstrike')}`) } catch (e) { parts.push('contains ERR ' + e) }
	parts.push(`isRadio=${raidIsRadio(item)}`)
	return parts.join(' | ')
}

ItemEvents.rightClicked(event => {
	if (String(event.item.id) != 'apocalypsenow:military_radio') return
	console.info('air_raid radio click: ' + event.player.username + ' ' + raidDescribeItem(event.item))
	if (!raidIsRadio(event.item)) return
	let srv = event.server
	let name = event.player.username
	event.cancel()
	if (raidRadioUsed[name] != null && raidTicks - raidRadioUsed[name] < RAID_RADIO_COOLDOWN) {
		srv.runCommandSilent(`tellraw ${name} {"text":"Рация перегрета. Подожди минуту.","color":"gray"}`)
		return
	}
	if (!raidOnlineOverworld(srv, name)) {
		srv.runCommandSilent(`tellraw ${name} {"text":"Нет связи с авиацией.","color":"gray"}`)
		return
	}
	if (!raidAhead(srv, name)) {
		srv.runCommandSilent(`tellraw ${name} {"text":"[Пилот] Отказ: цель слишком близко к базе. Разверни наводку.","color":"gold"}`)
		return
	}
	raidRadioUsed[name] = raidTicks
	event.item.count--
})

ServerEvents.commandRegistry(event => {
	let { commands: Commands } = event
	let op = src => src.hasPermission(2)
	event.register(Commands.literal('airraid').requires(op)
		// налёт по взгляду, как рацией
		.then(Commands.literal('ahead').executes(ctx => {
			let name = ctx.source.player.username
			if (!raidAhead(Utils.server, name)) Utils.server.runCommandSilent(`tellraw ${name} {"text":"Отказ: задевает базу.","color":"gray"}`)
			return 1
		}))
		// налёт по своим координатам
		.then(Commands.literal('here').executes(ctx => {
			let name = ctx.source.player.username
			if (!raidOnPlayer(Utils.server, name)) Utils.server.runCommandSilent(`tellraw ${name} {"text":"Отказ: задевает базу.","color":"gray"}`)
			return 1
		}))
		// налёт в случайном месте рядом с собой
		.then(Commands.literal('near').executes(ctx => {
			let name = ctx.source.player.username
			if (!raidNearPlayer(Utils.server, name)) Utils.server.runCommandSilent(`tellraw ${name} {"text":"Отказ: не нашлось места вне базы.","color":"gray"}`)
			return 1
		}))
		// предпросмотр налёта по взгляду: дым вместо TNT, расчёт только себе
		.then(Commands.literal('preview').executes(ctx => {
			raidPreview(Utils.server, ctx.source.player.username)
			return 1
		}))
		// диагностика: как скрипт видит предмет в главной руке (в лог)
		.then(Commands.literal('debugitem').executes(ctx => {
			let p = ctx.source.player
			console.info('air_raid debugitem: ' + p.username + ' ' + raidDescribeItem(p.mainHandItem))
			return 1
		}))
		// выдать рацию авиаудара
		.then(Commands.literal('radio').executes(ctx => {
			raidGiveRadio(Utils.server, ctx.source.player.username)
			return 1
		})))
})

ServerEvents.tick(event => {
	raidTicks++
	let srv = event.server
	if (raidQueue.length > 0) {
		let due = raidQueue.filter(q => q.at <= raidTicks)
		if (due.length > 0) {
			raidQueue = raidQueue.filter(q => q.at > raidTicks)
			due.forEach(q => {
				try { srv.runCommandSilent(q.cmd) } catch (e) { console.error('air_raid cmd: ' + e) }
			})
		}
	}
	if (!RAID_RANDOM_ENABLED || raidTicks % 1200 != 0) return
	if (Math.random() >= RAID_RANDOM_CHANCE_PER_MIN) return
	try {
		raidRandom(srv)
	} catch (e) {
		console.error('air_raid random: ' + e)
	}
})
