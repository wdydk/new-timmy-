'use strict';
const { spawn } = require('node:child_process');
const { Transform, Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const {
    joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
    NoSubscriberBehavior, StreamType, entersState, VoiceConnectionStatus,
    generateDependencyReport
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { UserError, Serial, cut } = require('./core');
const { P } = require('./permissions');

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BASE = ['--ignore-config', '--no-playlist', '--no-colors', '--socket-timeout', '15',
    '--retries', '2', '--extractor-retries', '2', '--js-runtimes', 'node'];
function musicQuery(input) {
    const text = String(input || '').trim();
    if (!text || text.length > 300) throw new UserError('Escribe un nombre o enlace de hasta 300 caracteres.');
    if (!/^https?:\/\//i.test(text)) {
        if (/^[\w+.-]+:/.test(text)) throw new UserError('Usa un nombre de canción o un enlace HTTPS de YouTube/Spotify.');
        return { source: `ytsearch1:${text}`, spotify: false };
    }
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        throw new UserError('Solo se aceptan enlaces HTTPS normales.');
    }
    if (url.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]+\/)?track\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
        return { source: url.href, spotify: true };
    }
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
        throw new UserError('Admito nombres y enlaces de canciones de YouTube o Spotify.');
    }
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) :
        url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw new UserError('Usa el enlace de un video individual, no una playlist.');
    return { source: `https://www.youtube.com/watch?v=${id}`, spotify: false };
}
function processResult(executable, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '', settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Tiempo de espera agotado')), timeout);
        child.on('error', error => finish(error));
        child.stdout.on('data', data => {
            out += data;
            if (out.length > 4 * 1024 * 1024) finish(new Error('Respuesta demasiado grande'));
        });
        child.stderr.on('data', data => { err = (err + data).slice(-6000); });
        child.on('close', code => finish(code === 0 ? null : new Error(err || `Proceso terminó con código ${code}`), out));
    });
}
function explainAudioError(error) {
    const text = String(error?.message || error);
    if (/ENOENT/.test(text)) return 'Falta FFmpeg o yt-dlp. Despliega con el Dockerfile nuevo y revisa >musicdiag.';
    if (/CERTIFICATE_VERIFY_FAILED|certificate verify failed/i.test(text)) return 'Falló la verificación del certificado de la fuente. Revisa los certificados del hosting; no desactives la verificación TLS.';
    if (/sign in|not a bot|403|429|confirm your age|cookies/i.test(text)) return 'YouTube rechazó la solicitud desde el hosting. Prueba otro video; no es un problema del comando. >audiotest permite comprobar la voz sin YouTube.';
    if (/private|unavailable|removed|copyright|not available/i.test(text)) return 'El video no está disponible para el servidor. Prueba otro enlace.';
    return 'No llegaron datos de audio o la conexión tardó demasiado. Ejecuta >musicdiag y >audiotest; revisa también los logs.';
}
async function resolveTrack(query) {
    let source = musicQuery(query);
    let spotify = false;
    if (source.spotify) {
        const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(source.source)}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new UserError('No pude leer esa canción de Spotify. Usa título y artista.');
        const data = await response.json();
        if (!data.title) throw new UserError('Spotify no devolvió el título. Usa título y artista.');
        source = { source: `ytsearch1:${String(data.title).slice(0, 250)} audio` };
        spotify = true;
    }
    let info;
    try {
        info = JSON.parse(await processResult(YTDLP, [...BASE, '--dump-single-json', '--skip-download', '--', source.source], 40000));
    } catch (error) {
        console.error('[YT-DLP SEARCH]', String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(-1800));
        throw new UserError(explainAudioError(error));
    }
    const video = info.entries ? info.entries.find(Boolean) : info;
    if (!video?.id || !/^[\w-]{11}$/.test(video.id)) throw new UserError('No encontré un video reproducible.');
    if (video.is_live || video.live_status === 'is_live' || !Number.isFinite(video.duration) || video.duration > 1800) {
        throw new UserError('Usa una canción de hasta 30 minutos; esta versión no admite directos.');
    }
    return { title: cut(video.title, 200), url: `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration, thumbnail: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`, spotify };
}
function toneBuffer(seconds = 3) {
    const samples = seconds * 48000;
    const buffer = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) {
        const fade = Math.min(1, i / 2400, (samples - i) / 2400);
        const value = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 2200 * fade);
        buffer.writeInt16LE(value, i * 4); buffer.writeInt16LE(value, i * 4 + 2);
    }
    return buffer;
}
class Music {
    constructor(client, store) {
        this.client = client; this.store = store;
        this.sessions = new Map(); this.serial = new Serial();
        this.searches = new Set();
    }
    async access(ctx) {
        if (!ctx.guild) throw new UserError('La música se usa dentro de un servidor.');
        const member = await ctx.guild.members.fetch(ctx.user.id);
        const voice = member.voice.channel;
        if (!voice || voice.type !== 2) throw new UserError('Entra en un canal de voz normal (no escenario).');
        const me = await ctx.guild.members.fetchMe();
        const permissions = voice.permissionsFor(me);
        if (!permissions?.has([P.ViewChannel, P.Connect, P.Speak])) throw new UserError('Necesito Ver canal, Conectar y Hablar en ese canal.');
        if (me.voice.serverMute) throw new UserError('El servidor tiene al bot silenciado. Quita el silencio del bot.');
        const active = this.sessions.get(ctx.guild.id);
        if (active && active.voiceId !== voice.id) throw new UserError('Debes estar en el mismo canal de voz que el bot.');
        return voice;
    }
    async control(ctx) {
        await this.access(ctx);
        const role = this.store.guild(ctx.guild.id).djRole;
        if (role && !ctx.member.roles.cache.has(role) && !ctx.member.permissions.has(P.ManageGuild)) {
            throw new UserError('Los controles están reservados al rol DJ configurado.');
        }
        const session = this.sessions.get(ctx.guild.id);
        if (!session) throw new UserError('No hay una sesión de música. Usa >play o >join.');
        return session;
    }
    async _connect(ctx) {
        const voice = await this.access(ctx);
        let session = this.sessions.get(ctx.guild.id);
        if (session) { session.text = ctx.channel; return session; }
        const connection = joinVoiceChannel({ channelId: voice.id, guildId: ctx.guild.id,
            adapterCreator: ctx.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
        session = { connection, player, guildId: ctx.guild.id, voiceId: voice.id, text: ctx.channel,
            queue: [], current: null, volume: 0.65, loop: 'off', destroyed: false, idleTimer: null };
        this.sessions.set(ctx.guild.id, session);
        connection.subscribe(player);
        player.on('stateChange', (old, state) => {
            if (state.status === AudioPlayerStatus.Idle && old.status !== AudioPlayerStatus.Idle) {
                this._scheduleFinish(session, old.resource?.metadata?.token, 'end');
            }
        });
        player.on('error', error => {
            this._scheduleFinish(session, error.resource?.metadata?.token, 'error', error);
        });
        connection.on('error', error => {
            console.error('[VOICE]', error.message);
            this.serial.run(session.guildId, () => this._destroy(session)).catch(console.error);
        });
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                ]);
                await entersState(connection, VoiceConnectionStatus.Ready, 20000);
            } catch {
                this.serial.run(session.guildId, () => this._destroy(session)).catch(console.error);
            }
        });
        try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); }
        catch { this._destroy(session); throw new UserError('No pude conectar la voz. Revisa permisos y la conexión UDP del hosting.'); }
        this._idleTimer(session);
        return session;
    }
    _idleTimer(s) {
        clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => {
            this.serial.run(s.guildId, () => { if (!s.current) this._destroy(s); }).catch(console.error);
        }, 120000);
        s.idleTimer.unref();
    }
    _cleanup(current) {
        if (!current) return;
        current.stopped = true;
        clearInterval(current.watchdog);
        for (const child of current.children || []) {
            child.stdout?.unpipe();
            child.kill('SIGKILL');
        }
        current.meter?.destroy();
    }
    _destroy(s) {
        if (!s || s.destroyed) return;
        s.destroyed = true; clearTimeout(s.idleTimer);
        this._cleanup(s.current); s.current = null; s.queue = [];
        s.player.stop(true);
        if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) s.connection.destroy();
        if (this.sessions.get(s.guildId) === s) this.sessions.delete(s.guildId);
    }
    _scheduleFinish(s, token, reason, error) {
        if (!token || s.destroyed) return;
        this.serial.run(s.guildId, () => this._finish(s, token, reason, error)).catch(error => console.error('[MUSIC]', error.message));
    }
    async _finish(s, token, reason, error) {
        if (s.destroyed || s.current?.token !== token) return;
        const old = s.current;
        s.current = null; this._cleanup(old); s.player.stop(true);
        if (reason === 'error') {
            console.error('[AUDIO]', String(error?.message || 'stream error').replace(/https?:\/\/\S+/g, '[URL]').slice(-1800));
            await s.text.send(`❌ ${explainAudioError(error)}`).catch(() => {});
        }
        if (reason === 'end' && !old.track.test) {
            if (s.loop === 'song') s.queue.unshift(old.track);
            else if (s.loop === 'queue') s.queue.push(old.track);
        } else if (reason === 'skip' && s.loop === 'queue' && !old.track.test) s.queue.push(old.track);
        await this._start(s);
    }
    async _start(s) {
        if (s.current || s.destroyed) return;
        clearTimeout(s.idleTimer);
        // Un fallo de extracción no bloquea ni repite infinitamente la pista.
        while (s.queue.length && !s.destroyed) {
            const track = s.queue.shift();
            const current = { track, token: randomUUID(), children: [], bytes: 0, lastByte: Date.now(), stopped: false };
            s.current = current;
            try {
                await entersState(s.connection, VoiceConnectionStatus.Ready, 15000);
                let stream;
                let failedReject;
                const failed = new Promise((_, reject) => { failedReject = reject; });
                const fail = error => {
                    if (current.stopped) return;
                    failedReject(error);
                    this._scheduleFinish(s, current.token, 'error', error);
                };
                // Este catch mantiene atendido el rechazo también después de iniciar.
                failed.catch(() => {});
                if (track.test) stream = Readable.from([toneBuffer()]);
                else {
                    const ytdlp = spawn(YTDLP, [...BASE, '-f', 'bestaudio/best', '-o', '-', '--', track.url],
                        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
                    const ffmpeg = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                        '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
                        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
                    current.children = [ytdlp, ffmpeg];
                    for (const child of current.children) {
                        let stderr = '';
                        child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
                        child.on('error', fail);
                        child.on('close', code => { if (code !== 0 && !current.stopped) fail(new Error(stderr || `Proceso terminó: ${code}`)); });
                        child.stdout.on('error', fail);
                    }
                    ffmpeg.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
                    ytdlp.stdout.pipe(ffmpeg.stdin);
                    stream = ffmpeg.stdout;
                }
                const meter = new Transform({ transform(chunk, encoding, cb) {
                    current.bytes += chunk.length; current.lastByte = Date.now(); cb(null, chunk);
                } });
                current.meter = meter;
                meter.on('error', fail);
                stream.pipe(meter);
                const resource = createAudioResource(meter, { inputType: StreamType.Raw,
                    inlineVolume: true, metadata: { token: current.token } });
                resource.volume.setVolume(s.volume);
                current.resource = resource;
                s.player.play(resource);
                await Promise.race([entersState(s.player, AudioPlayerStatus.Playing, 35000), failed]);
                if (!current.bytes) throw new Error('No se recibieron bytes de audio');
                current.watchdog = setInterval(() => {
                    if (s.player.state.status === AudioPlayerStatus.Playing && Date.now() - current.lastByte > 25000) {
                        fail(new Error('La fuente de audio dejó de enviar datos'));
                    }
                }, 5000);
                current.watchdog.unref();
                const embed = new EmbedBuilder().setColor(0x7c83ff).setTitle(track.test ? '🔊 Prueba de voz: tono de 3 segundos' : '🎶 Reproduciendo')
                    .setDescription(track.test ? 'Si oyes el tono, la ruta de voz funciona. Si YouTube falla, revisa la extracción.' : `[${track.title.replace(/[\[\]]/g, '')}](${track.url})`)
                    .setFooter({ text: `Volumen ${Math.round(s.volume * 100)}% • >musicdiag para diagnóstico` });
                if (track.thumbnail) embed.setThumbnail(track.thumbnail);
                if (track.spotify) embed.addFields({ name: 'Fuente', value: 'Resultado aproximado de YouTube buscado a partir de Spotify.' });
                await s.text.send({ embeds: [embed] }).catch(() => {});
                return;
            } catch (error) {
                this._cleanup(current); s.current = null; s.player.stop(true);
                console.error('[AUDIO START]', String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(-1800));
                await s.text.send(`❌ No se inició **${cut(track.title, 150)}**. ${explainAudioError(error)}`).catch(() => {});
            }
        }
        this._idleTimer(s);
    }
    async join(ctx) { return this.serial.run(ctx.guild.id, () => this._connect(ctx)); }
    async play(ctx, query) {
        await this.access(ctx);
        if (this.searches.has(ctx.user.id) || this.searches.size >= 3) throw new UserError('Hay búsquedas en curso. Espera unos segundos.');
        this.searches.add(ctx.user.id);
        let track;
        try { track = await resolveTrack(query); } finally { this.searches.delete(ctx.user.id); }
        track.requester = ctx.user.id;
        return this.serial.run(ctx.guild.id, async () => {
            const s = await this._connect(ctx);
            if (s.queue.length >= 50) throw new UserError('La cola admite hasta 50 canciones pendientes.');
            if (s.queue.filter(t => t.requester === ctx.user.id).length >= 10) throw new UserError('Ya tienes 10 canciones pendientes.');
            s.queue.push(track); await this._start(s);
            return track;
        });
    }
    async test(ctx) {
        await this.access(ctx);
        return this.serial.run(ctx.guild.id, async () => {
            const s = await this._connect(ctx);
            if (s.current || s.queue.length) throw new UserError('Primero detén la música con >stop.');
            s.queue.push({ title: 'Tono de prueba', test: true, requester: ctx.user.id });
            await this._start(s);
        });
    }
    async action(ctx, action, value) {
        return this.serial.run(ctx.guild.id, async () => {
            const s = await this.control(ctx);
            if (action === 'stop') { this._destroy(s); return; }
            if (action === 'volume') { s.volume = value / 100; s.current?.resource?.volume?.setVolume(s.volume); return; }
            if (action === 'loop') { s.loop = value; return; }
            if (action === 'shuffle') {
                for (let i = s.queue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1)); [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
                }
                return;
            }
            if (!s.current) throw new UserError('No hay una pista activa.');
            if (action === 'skip') return this._finish(s, s.current.token, 'skip');
            if (action === 'pause') s.player.pause();
            if (action === 'resume') s.player.unpause();
        });
    }
    diagnostic(guild) {
        const s = this.sessions.get(guild.id);
        return [
            `Sesión: ${s ? 'activa' : 'no conectada'}`,
            `Conexión: ${s?.connection.state.status || '—'}`,
            `Reproductor: ${s?.player.state.status || '—'}`,
            `PCM recibido: ${s?.current?.bytes || 0} bytes`,
            `Volumen: ${Math.round((s?.volume ?? .65) * 100)}%`,
            `Silenciado por servidor: ${Boolean(guild.members.me?.voice.serverMute)}`,
            `Pistas pendientes: ${s?.queue.length || 0}`,
            '', 'Prueba >audiotest sin música activa. Si no oyes el tono: revisa volumen del bot en tu Discord, silencio y permisos de voz.'
        ].join('\n');
    }
    closeAll() { for (const s of this.sessions.values()) this._destroy(s); }
}
module.exports = { Music, musicQuery, processResult, resolveTrack, toneBuffer, explainAudioError, generateDependencyReport };
