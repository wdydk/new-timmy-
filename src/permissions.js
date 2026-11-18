'use strict';
const { PermissionsBitField: { Flags: P } } = require('discord.js');
const { UserError } = require('./core');
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels,
    P.ManageMessages, P.ManageWebhooks, P.BanMembers, P.KickMembers, P.ModerateMembers,
    P.MentionEveryone, P.ManageEvents, P.ManageThreads];
function requirePermission(member, permission) {
    if (!member?.permissions.has(permission)) throw new UserError('No tienes el permiso necesario para esta acción.');
}
function requireHierarchy(actor, target, bot) {
    if (actor.id === target.id || target.id === bot.id || target.id === target.guild.ownerId) {
        throw new UserError('No puedes moderarte a ti mismo, al bot ni al dueño del servidor.');
    }
    if (actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
        throw new UserError('El miembro tiene un rango igual o superior al tuyo.');
    }
    if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
        throw new UserError('El rol del bot debe estar por encima del miembro.');
    }
}
function safeRole(role, bot, actor = null) {
    if (!role || role.id === role.guild.id || role.managed || !role.editable) {
        throw new UserError('Ese rol no es editable por el bot.');
    }
    if (role.permissions.any(DANGEROUS)) throw new UserError('Solo se permiten roles sin permisos de moderación o administración.');
    if (bot.roles.highest.comparePositionTo(role) <= 0) throw new UserError('Mueve el rol del bot por encima de ese rol.');
    if (actor && actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
        throw new UserError('Solo puedes gestionar roles por debajo del tuyo.');
    }
}
module.exports = { P, DANGEROUS, requirePermission, requireHierarchy, safeRole };
