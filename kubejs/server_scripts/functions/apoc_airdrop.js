// priority: 0
console.info('Loaded apoc_airdrop.js')

// Авиадропы Apocalypse Now: ящик медленно падает в 30-60 блоках от игрока и дымит.
// Родные рации мода вырезаны паком, так что сброс только командой (и таймером, если включить).
// Откат: удалить файл и /reload; дым выключить — "Drop Box smoke" = false в Apocalypse Now Config.toml.

const AN_DROP_CFG = Java.loadClass('net.mcreator.apocalypsenow.configuration.ApocalypsenowconfigurationConfiguration')
if (String(AN_DROP_CFG.DROP_BOX_SMOKE.get()) != 'true') AN_DROP_CFG.DROP_BOX_SMOKE.set(true)

// Автосброс: раз в час онлайна (72000 тиков, пока на сервере есть хоть кто-то) у случайного игрока.
const AIRDROP_RANDOM = true
const AIRDROP_INTERVAL_TICKS = 72000

const APOC_AIRDROPS = {
	common: 'apocalypsenow:dropbox',
	military: 'apocalypsenow:militarydrop',
	medical: 'apocalypsenow:medicaldropbox'
}

function apocAirdrop(server, player, kind) {
	let id = APOC_AIRDROPS[kind] || APOC_AIRDROPS.common
	let name = player.username   // не `${player}`: у ServerPlayer нет toString с ником
	let a = Math.random() * 6.283185307179586   // Math.PI в этом Rhino нет (даёт NaN)
	let r = 30 + Math.random() * 30
	// Смещение относительно игрока прямо в команде: координаты игрока из JS не читаются (player.x = NaN)
	let dx = Math.round(Math.cos(a) * r)
	let dz = Math.round(Math.sin(a) * r)
	// -Z север, +X восток
	let deg = (Math.atan2(dx, -dz) * 57.29577951308232 + 360) % 360
	// без индексации массива: в Rhino дробный индекс даёт undefined
	let dir = 'северу'
	if (deg >= 22.5 && deg < 67.5) dir = 'северо-востоку'
	else if (deg >= 67.5 && deg < 112.5) dir = 'востоку'
	else if (deg >= 112.5 && deg < 157.5) dir = 'юго-востоку'
	else if (deg >= 157.5 && deg < 202.5) dir = 'югу'
	else if (deg >= 202.5 && deg < 247.5) dir = 'юго-западу'
	else if (deg >= 247.5 && deg < 292.5) dir = 'западу'
	else if (deg >= 292.5 && deg < 337.5) dir = 'северо-западу'
	// /summon без NBT => finalizeSpawn => Slow Falling; с высоты 150 падает ~15 с
	server.runCommandSilent(`execute as ${name} at @s positioned ~${dx} 0 ~${dz} positioned over motion_blocking_no_leaves positioned ~ ~150 ~ run summon ${id} ~ ~ ~`)
	server.tell(Text.gold(`[Авиадроп] Груз сброшен в ~${Math.round(r)} блоках к ${dir} от ${name}. Ищите дым!`))
}

ServerEvents.commandRegistry(event => {
	let { commands: Commands } = event
	let node = Commands.literal('apocairdrop').requires(src => src.hasPermission(2))
	Object.keys(APOC_AIRDROPS).forEach(key => {
		node = node.then(Commands.literal(key).executes(ctx => {
			apocAirdrop(Utils.server, ctx.source.player, key)
			return 1
		}))
	})
	event.register(node)
})

// Счётчик свой: server.tickCount в этом Rhino не проверен. Считаем только время, когда кто-то онлайн.
let airdropTicks = 0

ServerEvents.tick(event => {
	if (!AIRDROP_RANDOM) return
	let srv = event.server
	let players = srv.players
	if (players.size() == 0) return
	airdropTicks++
	if (airdropTicks < AIRDROP_INTERVAL_TICKS) return
	airdropTicks = 0
	try {
		let p = players.get(Math.floor(Math.random() * players.size()))
		apocAirdrop(srv, p, Math.random() < 0.8 ? 'common' : 'military')
	} catch (e) {
		console.error('apoc_airdrop tick: ' + e)
	}
})
