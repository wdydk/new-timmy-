'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
const { P, requirePermission, requireHierarchy, safeRole } = require('../src/permissions');
const ranked = position => ({ position, comparePositionTo(other) { return this.position - other.position; } });
function member(id, position, flags = []) {
    return { id, guild: { id: 'g', ownerId: 'owner' }, roles: { highest: ranked(position) }, permissions: new PermissionsBitField(flags) };
}
test('gestionar mensajes no concede banear ni gestionar roles', () => {
    const m = member('moderator', 3, [P.ManageMessages]);
    requirePermission(m, P.ManageMessages);
    assert.throws(() => requirePermission(m, P.BanMembers));
    assert.throws(() => requirePermission(m, P.ManageRoles));
});
test('jerarquía protege rangos superiores, dueño y propio usuario', () => {
    const actor = member('a', 3), bot = member('bot', 10);
    assert.throws(() => requireHierarchy(actor, member('b', 4), bot));
    assert.throws(() => requireHierarchy(actor, member('owner', 1), bot));
    assert.throws(() => requireHierarchy(actor, actor, bot));
    requireHierarchy(actor, member('b', 2), bot);
});
test('autorroles y botones rechazan privilegios y roles altos', () => {
    const role = { ...ranked(2), id: 'r', guild: { id: 'g' }, editable: true, managed: false, permissions: new PermissionsBitField() };
    safeRole(role, member('bot', 10), member('a', 3));
    role.permissions.add(P.Administrator);
    assert.throws(() => safeRole(role, member('bot', 10), member('a', 3)));
    role.permissions = new PermissionsBitField(); role.position = 4;
    assert.throws(() => safeRole(role, member('bot', 10), member('a', 3)));
});
