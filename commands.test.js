'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/core');
const { buildBot } = require('../index');
const { P } = require('../src/permissions');
const { PermissionsBitField, Collection } = require('discord.js');
test('menú slash completo con permisos por acción y nombres válidos', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-commands-'));
    const app = buildBot({ store: new Store(dir) });
    t.after(async () => { await app.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
    const defs = app.slashDefinitions();
    assert.ok(defs.length > 40 && defs.length <= 100);
    assert.equal(new Set(defs.map(d => d.name)).size, defs.length);
    for (const d of defs) {
        assert.match(d.name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(d.description.length <= 100);
        let optional = false;
        for (const option of d.options) {
            if (!option.required) optional = true;
            if (optional) assert.ok(!option.required);
        }
    }
    assert.equal(defs.find(d => d.name === 'ban').default_member_permissions, P.BanMembers.toString());
    assert.equal(defs.find(d => d.name === 'snipe').default_member_permissions, P.ManageMessages.toString());
    assert.ok(defs.find(d => d.name === 'ask').contexts.includes(1));
});
test('modal de ticket genera JSON válido sin exceder etiquetas', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-ticket-'));
    const app = buildBot({ store: new Store(dir) });
    t.after(async () => { await app.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
    let data;
    await app.tickets.handle({ customId: 'tm:ticket:open', guild: { id: 'g' }, isStringSelectMenu: () => true,
        values: ['soporte'], showModal: async modal => { data = modal.toJSON(); } });
    assert.ok(data.components[0].components[0].label.length <= 45);
});
test('el despachador impide banear a quien solo gestiona mensajes', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-dispatch-'));
    const app = buildBot({ store: new Store(dir) });
    t.after(async () => { await app.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
    let called = false;
    const ctx = { guild: { id: 'g', members: { fetch: async () => { called = true; } } },
        member: { permissions: new PermissionsBitField([P.ManageMessages]) }, user: { id: 'u' },
        channel: { id: 'c', isThread: () => false }, reply: async () => {} };
    await assert.rejects(app.execute(ctx, 'ban', ['12345678901234567', 'test']));
    assert.equal(called, false);
});
test('un miembro ajeno no puede cerrar el ticket ni por prefijo ni por botón', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timmy-close-'));
    const app = buildBot({ store: new Store(dir) });
    t.after(async () => { await app.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
    app.store.data.tickets.c = { guildId: 'g', ownerId: 'owner' };
    const member = { id: 'other', roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
    const guild = { id: 'g', members: { fetch: async () => member } };
    const ctx = { guild, member, user: { id: 'other' }, channel: { id: 'c' }, reply: async () => { throw Error('Should not reply'); } };
    await assert.rejects(app.execute(ctx, 'close', []), /Solo el autor/);
    await assert.rejects(app.tickets.handle({ customId: 'tm:ticket:close', guild, guildId: 'g', channelId: 'c', user: { id: 'other' },
        isStringSelectMenu: () => false, isModalSubmit: () => false, isButton: () => true }), /Solo el autor/);
});
