'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createAudioPlayer, NoSubscriberBehavior, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const { Music, musicQuery, toneBuffer, processResult } = require('../src/music');
test('fuentes rechazan URLs privadas, opciones y playlists', () => {
    for (const query of ['http://127.0.0.1/x', 'https://localhost/x', 'https://youtube.com.evil.test/watch?v=aaaaaaaaaaa', 'file:///etc/passwd', 'https://youtube.com/playlist?list=x']) assert.throws(() => musicQuery(query));
    assert.equal(musicQuery('--exec whoami').source, 'ytsearch1:--exec whoami');
    assert.equal(musicQuery('https://youtu.be/abcdefghijk').source, 'https://www.youtube.com/watch?v=abcdefghijk');
});
test('tono PCM tiene duración esperada y amplitud no nula', () => {
    const b = toneBuffer(1); assert.equal(b.length, 48000 * 4);
    assert.ok(b.some(v => v !== 0));
});
test('proceso faltante o fallido devuelve error, no éxito', async () => {
    await assert.rejects(processResult('timmy-no-such-bin', [], 1000));
    await assert.rejects(processResult(process.execPath, ['-e', 'process.exit(1)'], 2000));
});
test('ruta real PCM -> Opus -> AudioPlayer entra en Playing antes del anuncio', async t => {
    const sent = [];
    const m = new Music({}, { guild: () => ({}) });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const s = { player, connection: { state: { status: VoiceConnectionStatus.Ready } },
        guildId: 'g', queue: [{ title: 'Test', test: true }], current: null, volume: .65,
        destroyed: false, text: { send: async payload => { sent.push({ payload, status: player.state.status }); } } };
    t.after(() => { m._cleanup(s.current); player.stop(true); clearTimeout(s.idleTimer); });
    await m._start(s);
    assert.equal(player.state.status, AudioPlayerStatus.Playing);
    assert.ok(s.current.bytes > 0);
    assert.equal(sent[0].status, AudioPlayerStatus.Playing);
});
test('eventos atrasados no saltan dos pistas', async () => {
    const m = new Music({}, {}); let starts = 0;
    m._start = async () => { starts++; };
    const s = { destroyed: false, current: { token: 'old', track: { title: 'A' }, children: [] },
        queue: [], loop: 'queue', player: { stop() {} } };
    await m._finish(s, 'old', 'skip'); await m._finish(s, 'old', 'end');
    assert.equal(starts, 1); assert.equal(s.queue.length, 1);
});
test('FFmpeg genera PCM estéreo a 48 kHz sin silenciar errores', async () => {
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
        const chunks = []; let stderr = '';
        child.stdout.on('data', c => chunks.push(c));
        child.stderr.on('data', c => { stderr += c; });
        child.on('error', reject);
        child.on('close', code => code ? reject(Error(stderr)) : resolve(Buffer.concat(chunks)));
    });
    assert.equal(result.length, 48000 * 2 * 2);
    assert.ok(result.some(byte => byte !== 0));
});
