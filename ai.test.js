'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Assistant } = require('../src/ai');
test('IA aísla DMs y servidores y no dispone de herramientas de moderación', async () => {
    const requests = [];
    const a = new Assistant({ generate: async req => { requests.push(req); return { text: 'Hola' }; } });
    await a.ask('dm:one:u', 'u', 'privado');
    await a.ask('g:channel:v', 'v', 'servidor');
    assert.equal(requests[1].contents.length, 1);
    assert.ok(!JSON.stringify(requests[1].contents).includes('privado'));
    assert.equal(requests[0].config.tools, undefined);
    a.forget('dm:one:u'); assert.equal(a.history.get('dm:one:u'), undefined);
});
test('forget durante una respuesta no restaura historial y limita concurrencia', async () => {
    let done;
    const a = new Assistant({ generate: () => new Promise(r => { done = r; }) });
    const pending = a.ask('dm:a', 'a', 'hola');
    await assert.rejects(a.ask('dm:a', 'b', 'otra'));
    a.forget('dm:a'); done({ text: 'Respuesta' }); await pending;
    assert.equal(a.history.get('dm:a'), undefined);
    assert.equal(a.active, 0);
});
