// priority: 0
console.info('Loaded horde_siren.js')

// Сирена перед ночью орды и музыка, которая играет, пока у игрока идёт орда.
// Треки — из серверного ресурспака deceasedcraft-horde-pack (namespace deceasedhorde).
//
// День орды определяется ПО ИГРОКУ: HordeEvent.isHordeDay(player) / isActive(player).
// HordeSavedData.getNextDay() в день орды уже сдвинут на +hordeSpawnDays, сравнивать его с днём нельзя.
//
// Грабли Rhino на этом сервере: нет Math.PI; getGameTime()/getUUID() не маппятся;
// const внутри многократно вызываемых функций падает; все server_scripts делят одну область имён.
// Откат: удалить файл и /reload.
const SirenHordeSavedData = Java.loadClass('net.smileycorp.hordes.hordeevent.capability.HordeSavedData')

const SIREN_DAY_LENGTH = 24000
const SIREN_FROM = 12800          // hordeStartTime (13000) - 200
const SIREN_TO = 13000
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

function sirenPlayTrack(server, name, index) {
	let track = SIREN_TRACKS[index]
	sirenCmd(server, name, 'stopsound @s record')
	sirenCmd(server, name, `playsound ${track.id} record @s ~ ~ ~ 1 1`)
	sirenMusic[name] = { track: index, endsAt: sirenTicks + track.ticks }
}

function sirenStopMusic(server, name) {
	if (!sirenMusic[name]) return
	sirenCmd(server, name, 'stopsound @s record')
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
	let inWindow = tod >= SIREN_FROM && tod < SIREN_TO
	let day = Math.floor(time / SIREN_DAY_LENGTH)
	let data = SirenHordeSavedData.getData(level)
	let pd = srv.persistentData
	let online = {}

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
		let hordeDay = ev.isHordeDay(p)
		// Ключ по нику, в server.persistentData: сирена не повторится в тот же день после смерти/релога/reload
		let sKey = 'hordeSiren_' + name
		let lastDay = pd.getInt(sKey)
		if (dryRun) {
			srv.tell(Text.gray(`horde_siren status: ${name} day=${day} tod=${tod} window=${inWindow} active=${active} hordeDay=${hordeDay} lastSirenDay=${lastDay} music=${sirenMusic[name] ? 'да' : 'нет'}`))
			return
		}

		// 1) Сирена + первый трек: у игрока день орды, орда вот-вот начнётся
		if (inWindow && !active && hordeDay && lastDay != day) {
			pd.putInt(sKey, day)
			hordeSiren(srv, name)
			return
		}

		let music = sirenMusic[name]
		if (active) {
			// 2) Орда идёт: трек кончился (или игрок зашёл посреди орды) — следующий
			if (!music) sirenPlayTrack(srv, name, Math.floor(Math.random() * SIREN_TRACKS.length) % SIREN_TRACKS.length)
			else if (sirenTicks >= music.endsAt) sirenPlayTrack(srv, name, (music.track + 1) % SIREN_TRACKS.length)
		} else if (music && !(inWindow && hordeDay)) {
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
			sirenCmd(Utils.server, name, 'stopsound @s record')
			delete sirenMusic[name]
			return 1
		}))
		// Диагностика: что решил бы тик для каждого игрока (пишет в общий чат и latest.log)
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
