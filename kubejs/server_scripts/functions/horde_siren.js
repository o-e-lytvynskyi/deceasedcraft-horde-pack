// priority: 0
console.info('Loaded horde_siren.js')

// Сирена перед ночью орды, музыка и угрозы во время орды, синхронизация орды между игроками.
// Треки — из серверного ресурспака deceasedcraft-horde-pack (namespace deceasedhorde).
//
// Как устроен The Hordes (1.5.4c, hordeEventByPlayerTime = false):
// - общий график — HordeSavedData.next_day; сдвигается на +hordeSpawnDays в ПЕРВОМ тике дня орды;
// - у каждого игрока свой HordeEvent со своим nextDay; орда стартует у игрока, если он в верхнем мире,
//   время суток в [hordeStartTime, hordeStartTime + hordeStartBuffer] и день мира >= его nextDay;
// - при входе (setPlayer) nextDay пересчитывается от общего next_day — зашедший в день орды
//   получает nextDay = день + 15 и сегодняшнюю орду пропускает. Отсюда рассинхрон.
// - волна идёт, когда timer % spawnInterval == 0 (timer = оставшиеся тики, стартует с hordeSpawnDuration);
//   timer доступен только через HordeEvent.toString(String) — «ticksLeft=N».
// Синхронизация: в день орды до конца окна старта всем онлайн ставим nextDay = сегодня,
// в остальные дни — nextDay = общий next_day (отменяет «зависшие» орды в неурочные ночи).
// Считаем, что hordeSpawnVariation = 0 и скрипты орды не меняют длительность/интервал (как в паке).
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
// Угрозы в общий чат: по одной на волну, без повторов, пока не пройдут все.
// Без двойных кавычек и обратных слэшей — строка вставляется в JSON tellraw.
const SIREN_THREATS = [
	'Вы уже мертвы. Просто ещё не легли.',
	'Мы чуем вашу кровь. Ни одна дверь вас не спасёт.',
	'Этой ночью мы вырвем вам глотки и сожрём вас ещё тёплыми.',
	'Бегите. Так мясо вкуснее.',
	'Ваши стены — картон. Патроны кончатся. Крики — нет.',
	'К рассвету от вас останутся только кости и лужи.',
	'Мы разорвём вас на куски и растащим по всему городу.',
	'Прячьтесь сколько хотите. Мы выгрызем вас из любой щели.',
	'Каждый выстрел зовёт нас. Стреляйте громче.',
	'Ваши друзья уже с нами. Скоро и вы будете голодны.',
	'Мы переломаем вам кости одну за другой, пока вы ещё дышите.',
	'Никто не доживёт до утра. Никто.',
	'Слышите хруст? Это ваша баррикада. Следующими будут ваши рёбра.',
	'Мы выедим вам глаза, чтобы вы не видели, кто грызёт дальше.',
	'Молитесь. Это не поможет, но нам нравится, как вы скулите.'
]
const SIREN_THREAT_DEDUP_TICKS = 200   // волны разных игроков в пределах 10 с — одна фраза

let sirenTicks = 0
let sirenFailed = false
// ник -> { track: индекс, endsAt: sirenTicks }; живёт в памяти, после reload музыка стартует заново
let sirenMusic = {}
// ник -> номер последней объявленной волны
let sirenWaves = {}
let sirenThreatBag = []
let sirenLastThreatTick = -100000

function sirenCmd(server, name, cmd) {
	server.runCommandSilent(`execute as ${name} at @s run ${cmd}`)
}

function sirenJsonText(text) {
	return String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Служебные подробности — только тому, кто спросил (оператору), не в общий чат
function sirenReply(server, name, text) {
	server.runCommandSilent(`tellraw ${name} {"text":"${sirenJsonText(text)}","color":"gray"}`)
}

function sirenNextThreat() {
	if (sirenThreatBag.length == 0) {
		let bag = []
		for (let i = 0; i < SIREN_THREATS.length; i++) bag.push(i)
		for (let i = bag.length - 1; i > 0; i--) {
			let j = Math.floor(Math.random() * (i + 1))
			let t = bag[i]; bag[i] = bag[j]; bag[j] = t
		}
		sirenThreatBag = bag
	}
	return SIREN_THREATS[sirenThreatBag.pop()]
}

function sirenBroadcastThreat(server) {
	if (sirenTicks - sirenLastThreatTick < SIREN_THREAT_DEDUP_TICKS) return
	sirenLastThreatTick = sirenTicks
	server.runCommandSilent(`tellraw @a {"text":"☠ ${sirenJsonText(sirenNextThreat())}","color":"dark_red","bold":true}`)
}

// Оставшиеся тики орды игрока (поле timer приватное, есть только в toString)
function sirenTicksLeft(ev) {
	let m = String(ev.toString('')).match(/ticksLeft=(\d+)/)
	return m ? Number(m[1]) : -1
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

// Обход игроков. replyTo = ник оператора: только написать ему, что решил бы тик (/hordesiren status).
function sirenCheck(srv, replyTo) {
	let dryRun = !!replyTo
	let level = srv.overworld()
	let time = level.getDayTime()
	let tod = time % SIREN_DAY_LENGTH
	let day = Math.floor(time / SIREN_DAY_LENGTH)
	let data = SirenHordeSavedData.getData(level)
	let pd = srv.persistentData

	let spawnDays = Number(SirenHordeConfig.hordeSpawnDays.get())
	let startTime = Number(SirenHordeConfig.hordeStartTime.get())
	let startEnd = startTime + Number(SirenHordeConfig.hordeStartBuffer.get())
	let duration = Number(SirenHordeConfig.hordeSpawnDuration.get())
	let interval = Number(SirenHordeConfig.hordeSpawnInterval.get())
	let globalNext = data.getNextDay()
	// next_day уже сдвинут в первом тике дня орды, поэтому сегодня орда, если день = next_day - интервал
	let hordeToday = day == globalNext - spawnDays
	let inWindow = hordeToday && tod >= startTime - SIREN_LEAD_TICKS && tod < startTime
	let online = {}

	if (dryRun) sirenReply(srv, replyTo, `horde_siren status: day=${day} tod=${tod} next_day=${globalNext} hordeToday=${hordeToday} sirenWindow=${inWindow} threatsLeftInBag=${sirenThreatBag.length}`)

	srv.players.forEach(p => {
		let name = p.username
		online[name] = true
		// getEvent перегружен (ServerPlayer / UUID) — передаём UUID, getUUID() не маппится
		let ev = data.getEvent(p.profile.getId())
		if (ev == null) {
			if (dryRun) sirenReply(srv, replyTo, `horde_siren status: ${name} — нет HordeEvent`)
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
			let left = active ? sirenTicksLeft(ev) : 0
			sirenReply(srv, replyTo, `horde_siren status: ${name} active=${active} ticksLeft=${left} wave=${sirenWaves[name] || 0} nextDay=${nextDay}${wantNext != nextDay ? ' -> ' + wantNext : ''} hordeDay=${ev.isHordeDay(p)} lastSirenDay=${pd.getInt('hordeSiren_' + name)} music=${sirenMusic[name] ? 'да' : 'нет'}`)
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

			// 3) Новая волна — угроза в общий чат (волны: timer = duration, duration - interval, ...)
			let left = sirenTicksLeft(ev)
			if (left > 0 && interval > 0) {
				let wave = Math.floor((duration - left) / interval) + 1
				if (wave > (sirenWaves[name] || 0)) {
					sirenWaves[name] = wave
					sirenBroadcastThreat(srv)
				}
			}
		} else {
			delete sirenWaves[name]
			if (music && !inWindow) {
				// 4) Орда кончилась — выключить музыку (окно сирены не трогаем: там орда ещё не стартовала)
				sirenStopMusic(srv, name)
			}
		}
	})

	// Вышедшие игроки — забыть состояние
	if (!dryRun) {
		Object.keys(sirenMusic).forEach(n => { if (!online[n]) delete sirenMusic[n] })
		Object.keys(sirenWaves).forEach(n => { if (!online[n]) delete sirenWaves[n] })
	}
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
		// Тест: следующая угроза только себе (в общий чат не уходит, колоду расходует)
		.then(Commands.literal('threat').executes(ctx => {
			let name = ctx.source.player.username
			Utils.server.runCommandSilent(`tellraw ${name} {"text":"☠ ${sirenJsonText(sirenNextThreat())}","color":"dark_red","bold":true}`)
			return 1
		}))
		// Диагностика: график орды и что решил бы тик — только вызвавшему
		.then(Commands.literal('status').executes(ctx => {
			let name = ctx.source.player.username
			try {
				sirenCheck(Utils.server, name)
			} catch (e) {
				sirenReply(Utils.server, name, 'horde_siren status: ' + e)
			}
			return 1
		})))
})

ServerEvents.tick(event => {
	if (sirenFailed) return
	sirenTicks++
	if (sirenTicks % 20 != 0) return
	try {
		sirenCheck(event.server, null)
	} catch (e) {
		// Одна ошибка — и тик отключается до следующего reload, чтобы не спамить лог
		sirenFailed = true
		console.error('horde_siren.js отключён до reload: ' + e)
	}
})
