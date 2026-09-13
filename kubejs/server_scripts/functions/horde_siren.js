// priority: 0
console.info('Loaded horde_siren.js')

// Сирена перед ночью орды, музыка во время орды и синхронизация орды между игроками.
// Треки — из серверного ресурспака deceasedcraft-horde-pack (namespace deceasedhorde).
//
// Как устроен The Hordes (1.5.4c, hordeEventByPlayerTime = false):
// - общий график — HordeSavedData.next_day; сдвигается на +hordeSpawnDays в ПЕРВОМ тике дня орды;
// - у каждого игрока свой HordeEvent со своим nextDay; орда стартует у игрока, если он в верхнем мире,
//   время суток в [hordeStartTime, hordeStartTime + hordeStartBuffer] и день мира >= его nextDay;
// - при входе (setPlayer) nextDay пересчитывается от общего next_day — зашедший в день орды
//   получает nextDay = день + 15 и сегодняшнюю орду пропускает. Отсюда рассинхрон.
// Синхронизация: в день орды до конца окна старта всем онлайн ставим nextDay = сегодня,
// в остальные дни — nextDay = общий next_day (отменяет «зависшие» орды в неурочные ночи).
// Считаем, что hordeSpawnVariation = 0 (как в паке), иначе день орды по next_day не вычислить.
//
// Грабли Rhino на этом сервере: нет Math.PI; getGameTime()/getUUID() не маппятся;
// const внутри многократно вызываемых функций падает; все server_scripts делят одну область имён.
// Откат: удалить файл и /reload.
const SirenHordeSavedData = Java.loadClass('net.smileycorp.hordes.hordeevent.capability.HordeSavedData')
const SirenHordeConfig = Java.loadClass('net.smileycorp.hordes.config.HordeEventConfig')

const SIREN_DAY_LENGTH = 24000
const SIREN_LEAD_TICKS = 200       // сирена за 10 с до старта орды
// Категория звука: не music/record — многие играют с выключенной музыкой.
// hostile («Враждебные существа») почти никто не глушит, и вой орды уже в ней.
const SIREN_MUSIC_CATEGORY = 'hostile'
// Длительность в тиках (+2 с запаса), чтобы следующий трек не наезжал на текущий
const SIREN_TRACKS = [
	{ id: 'deceasedhorde:horde.music.smaragdove_nebo', ticks: 3740 + 40 },
	{ id: 'deceasedhorde:horde.music.plyashka_fragolino', ticks: 4260 + 40 }
]

let sirenTicks = 0
let sirenFailed = false
// ник -> { track: индекс, endsAt: sirenTicks }; живёт в памяти, после reload музыка стартует заново
let sirenMusic = {}

function sirenCmd(server, name, cmd) {
	server.runCommandSilent(`execute as ${name} at @s run ${cmd}`)
}

// Останавливаем только свои треки по id — остальные звуки категории (зомби) не трогаем
function sirenStopTracks(server, name) {
	SIREN_TRACKS.forEach(t => sirenCmd(server, name, `stopsound @s ${SIREN_MUSIC_CATEGORY} ${t.id}`))
}

function sirenPlayTrack(server, name, index) {
	let track = SIREN_TRACKS[index]
	sirenStopTracks(server, name)
	sirenCmd(server, name, `playsound ${track.id} ${SIREN_MUSIC_CATEGORY} @s ~ ~ ~ 1 1`)
	sirenMusic[name] = { track: index, endsAt: sirenTicks + track.ticks }
}

function sirenStopMusic(server, name) {
	if (!sirenMusic[name]) return
	sirenStopTracks(server, name)
	delete sirenMusic[name]
}

function hordeSiren(server, name) {
	sirenCmd(server, name, 'title @s subtitle {"text":"Держитесь до рассвета","color":"gray"}')
	sirenCmd(server, name, 'title @s title {"text":"ОРДА","color":"dark_red","bold":true}')
	sirenCmd(server, name, 'playsound hordes:horde_spawn hostile @s ~ ~ ~ 1 0.5')
	sirenPlayTrack(server, name, Math.floor(Math.random() * SIREN_TRACKS.length) % SIREN_TRACKS.length)
}

// Обход игроков. dryRun = только написать в чат, что решил бы тик (для /hordesiren status).
function sirenCheck(srv, dryRun) {
	let level = srv.overworld()
	let time = level.getDayTime()
	let tod = time % SIREN_DAY_LENGTH
	let day = Math.floor(time / SIREN_DAY_LENGTH)
	let data = SirenHordeSavedData.getData(level)
	let pd = srv.persistentData

	let spawnDays = Number(SirenHordeConfig.hordeSpawnDays.get())
	let startTime = Number(SirenHordeConfig.hordeStartTime.get())
	let startEnd = startTime + Number(SirenHordeConfig.hordeStartBuffer.get())
	let globalNext = data.getNextDay()
	// next_day уже сдвинут в первом тике дня орды, поэтому сегодня орда, если день = next_day - интервал
	let hordeToday = day == globalNext - spawnDays
	let inWindow = hordeToday && tod >= startTime - SIREN_LEAD_TICKS && tod < startTime
	let online = {}

	if (dryRun) srv.tell(Text.gray(`horde_siren status: day=${day} tod=${tod} next_day=${globalNext} hordeToday=${hordeToday} sirenWindow=${inWindow}`))

	srv.players.forEach(p => {
		let name = p.username
		online[name] = true
		// getEvent перегружен (ServerPlayer / UUID) — передаём UUID, getUUID() не маппится
		let ev = data.getEvent(p.profile.getId())
		if (ev == null) {
			if (dryRun) srv.tell(Text.gray(`horde_siren status: ${name} — нет HordeEvent`))
			return
		}
		let active = ev.isActive(p)
		let nextDay = ev.getNextDay()

		// 0) Синхронизация личного nextDay с общим графиком
		let wantNext = nextDay
		if (!active) {
			if (hordeToday) {
				// до конца окна старта: сегодняшняя орда должна случиться у всех онлайн
				if (tod < startEnd && nextDay > day) wantNext = day
			} else if (nextDay != globalNext) {
				wantNext = globalNext
			}
		}
		if (dryRun) {
			let sKey0 = 'hordeSiren_' + name
			srv.tell(Text.gray(`horde_siren status: ${name} active=${active} nextDay=${nextDay}${wantNext != nextDay ? ' -> ' + wantNext : ''} hordeDay=${ev.isHordeDay(p)} lastSirenDay=${pd.getInt(sKey0)} music=${sirenMusic[name] ? 'да' : 'нет'}`))
			return
		}
		if (wantNext != nextDay) {
			ev.setNextDay(wantNext)
			console.info(`horde_siren: ${name} nextDay ${nextDay} -> ${wantNext} (day=${day}, next_day=${globalNext})`)
		}

		// 1) Сирена + первый трек: у игрока день орды, орда вот-вот начнётся
		let sKey = 'hordeSiren_' + name
		if (inWindow && !active && ev.isHordeDay(p) && pd.getInt(sKey) != day) {
			pd.putInt(sKey, day)
			hordeSiren(srv, name)
			return
		}

		let music = sirenMusic[name]
		if (active) {
			// 2) Орда идёт: трек кончился (или игрок зашёл посреди орды) — следующий
			if (!music) sirenPlayTrack(srv, name, Math.floor(Math.random() * SIREN_TRACKS.length) % SIREN_TRACKS.length)
			else if (sirenTicks >= music.endsAt) sirenPlayTrack(srv, name, (music.track + 1) % SIREN_TRACKS.length)
		} else if (music && !inWindow) {
			// 3) Орда кончилась — выключить музыку (окно сирены не трогаем: там орда ещё не стартовала)
			sirenStopMusic(srv, name)
		}
	})

	// Вышедшие игроки — забыть состояние
	if (!dryRun) Object.keys(sirenMusic).forEach(n => { if (!online[n]) delete sirenMusic[n] })
}

ServerEvents.commandRegistry(event => {
	let { commands: Commands } = event
	event.register(Commands.literal('hordesiren').requires(src => src.hasPermission(2))
		// Тест: сирена и случайный трек себе, не дожидаясь орды
		.executes(ctx => {
			hordeSiren(Utils.server, ctx.source.player.username)
			return 1
		})
		// Выключить музыку себе
		.then(Commands.literal('stop').executes(ctx => {
			let name = ctx.source.player.username
			sirenStopTracks(Utils.server, name)
			delete sirenMusic[name]
			return 1
		}))
		// Диагностика: график орды и что решил бы тик для каждого игрока (в общий чат и latest.log)
		.then(Commands.literal('status').executes(ctx => {
			try {
				sirenCheck(Utils.server, true)
			} catch (e) {
				Utils.server.tell(Text.red('horde_siren status: ' + e))
			}
			return 1
		})))
})

ServerEvents.tick(event => {
	if (sirenFailed) return
	sirenTicks++
	if (sirenTicks % 20 != 0) return
	try {
		sirenCheck(event.server, false)
	} catch (e) {
		// Одна ошибка — и тик отключается до следующего reload, чтобы не спамить лог
		sirenFailed = true
		console.error('horde_siren.js отключён до reload: ' + e)
	}
})
