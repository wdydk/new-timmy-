'use strict';
require('dotenv').config({ quiet: true });
const path = require('node:path');
const {
    Client, GatewayIntentBits: I, Partials, EmbedBuilder, ActivityType,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, AttachmentBuilder, MessageFlags
} = require('discord.js');
const { UserError, cut, idOf, integer, duration, tokenize, render, Store, ExpiringCache } = require('./src/core');
const { P, requirePermission, requireHierarchy, safeRole } = require('./src/permissions');
const { Music, generateDependencyReport } = require('./src/music');
const { Assistant } = require('./src/ai');
const { Tickets } = require('./src/tickets');

function buildBot({ store, client, ai } = {}) {
    store ||= new Store(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data'));
    client ||= new Client({
        intents: [I.Guilds, I.GuildMembers, I.GuildMessages, I.MessageContent,
            I.GuildPresences, I.GuildVoiceStates, I.DirectMessages],
        partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember],
        allowedMentions: { parse: [], repliedUser: false }
    });
    ai ||= new Assistant();
    const music = new Music(client, store);
    const snipes = new ExpiringCache(5 * 60000, 1000);
    const edits = new ExpiringCache(5 * 60000, 1000);
    const cooldown = new ExpiringCache(1500, 10000);
    const reactionCooldown = new ExpiringCache(5000, 5000);
    const spam = new ExpiringCache(8000, 5000);
    const autoSanctions = new ExpiringCache(60000, 1000);
    const commands = new Map();
    const aliases = new Map();
    const definitions = [];
    let stopping = false;

    const embed = (title, text) => new EmbedBuilder().setColor(0x7c83ff).setTitle(cut(title, 256)).setDescription(cut(text, 4000));
    async function log(guild, title, text) {
        const id = store.guild(guild.id).logChannel;
        if (!id) return;
        try {
            const channel = await guild.channels.fetch(id);
            if (channel?.isTextBased()) await channel.send({ embeds: [embed(title, text).setTimestamp()] });
        } catch (error) { console.error('[LOG]', error.code || error.name); }
    }
    const tickets = new Tickets(client, store, log);
    function add(name, description, usage, options, handler) {
        const def = { name, description, usage, guild: options.guild !== false,
            permission: options.permission, private: Boolean(options.private), handler, category: options.category || 'Utilidades',
            params: options.params || [], aliases: options.aliases || [] };
        definitions.push(def); commands.set(name, def);
        for (const alias of def.aliases) aliases.set(alias, name);
    }
    const textParam = (name, description, required = true) => ({ type: 3, name, description, required });
    const userParam = (name = 'usuario', required = true) => ({ type: 6, name, description: 'Miembro del servidor', required });
    const numParam = (name, description, min, max, required = true) => ({ type: 4, name, description, min_value: min, max_value: max, required });
    const optConfig = (permission = P.ManageGuild) => ({ permission, category: 'Configuración', params: [textParam('opciones', 'Opciones según >help. Admite menciones y IDs.')] });
    async function getMember(ctx, input = ctx.user.id) {
        return ctx.guild.members.fetch(idOf(input)).catch(() => { throw new UserError('No encontré ese miembro en este servidor.'); });
    }
    async function getChannel(ctx, input, category = false) {
        const channel = await ctx.guild.channels.fetch(idOf(input)).catch(() => null);
        if (!channel || (category ? channel.type !== ChannelType.GuildCategory : channel.type !== ChannelType.GuildText)) {
            throw new UserError(category ? 'Indica el ID de una categoría.' : 'Indica un canal de texto con #canal o su ID.');
        }
        if (!category && !channel.permissionsFor(ctx.member)?.has([P.ViewChannel, P.SendMessages])) throw new UserError('No tienes acceso para escribir en ese canal.');
        return channel;
    }
    async function getRole(ctx, input) {
        const role = await ctx.guild.roles.fetch(idOf(input)).catch(() => null);
        if (!role) throw new UserError('No encontré ese rol.');
        return role;
    }
    async function botPermission(ctx, permission) {
        const me = await ctx.guild.members.fetchMe();
        if (!me.permissions.has(permission)) throw new UserError('Al bot le falta el permiso necesario para esta acción.');
        return me;
    }
    async function modTarget(ctx, input, permission) {
        const target = await getMember(ctx, input);
        const me = await botPermission(ctx, permission);
        requireHierarchy(ctx.member, target, me);
        return target;
    }
    function checkStaff(member) { return member.permissions.has(P.ManageMessages) || member.permissions.has(P.ModerateMembers); }
    const aiKey = ctx => `${ctx.guild?.id || 'dm'}:${ctx.channel.id}:${ctx.user.id}`;
    async function respondAI(ctx, text) {
        const cfg = ctx.guild ? store.guild(ctx.guild.id) : null;
        if (cfg && !cfg.ai) throw new UserError('La IA está desactivada en este servidor.');
        if (!ctx.guild && process.env.AI_DM_ENABLED === 'false') throw new UserError('El administrador desactivó la IA por DM.');
        const answer = await ai.ask(aiKey(ctx), ctx.user.id, text, cfg?.knowledge || '');
        for (const chunk of answer.match(/[\s\S]{1,1900}/g) || []) await ctx.reply(chunk);
    }

    add('help', 'Muestra comandos y configuración', '>help [categoría]', { guild: false, aliases: ['ayuda'], params: [textParam('categoria', 'Música, Moderación, Configuración, Tickets, IA o Utilidades', false)] }, async (ctx, args) => {
        const category = args.join(' ').toLocaleLowerCase('es');
        const selected = definitions.filter(d => !category || d.category.toLocaleLowerCase('es') === category || d.name === category);
        if (!selected.length) throw new UserError('Categorías: Música, Moderación, Configuración, Tickets, IA y Utilidades.');
        const rows = new Map();
        for (const d of selected) {
            const key = d.category;
            rows.set(key, [...(rows.get(key) || []), `\`${d.usage}\` — ${d.description}${d.permission ? ' 🔒' : ''}`]);
        }
        const pages = [];
        for (const [name, lines] of rows) {
            let body = '';
            for (const line of lines) {
                if ((body + line).length > 3600) { pages.push(embed(`Timmy Max • ${name}`, body)); body = ''; }
                body += line + '\n';
            }
            if (body) pages.push(embed(`Timmy Max • ${name}`, body));
        }
        // Un mensaje por categoría permite leer la ayuda sin exceder los límites.
        for (const page of pages) await ctx.reply({ embeds: [page] });
    });
    add('ping', 'Comprueba conexión y latencia', '>ping', { guild: false }, async ctx => ctx.reply(`🏓 Pong • Gateway: ${client.ws.ping} ms`));
    add('avatar', 'Muestra un avatar', '>avatar [@usuario]', { aliases: ['av', 'pfp'], params: [userParam('usuario', false)] }, async (ctx, args) => {
        const target = await getMember(ctx, args[0] || ctx.user.id);
        await ctx.reply({ embeds: [embed(`Avatar de ${target.user.username}`, `[Abrir imagen](${target.user.displayAvatarURL({ size: 1024 })})`).setImage(target.user.displayAvatarURL({ size: 1024 }))] });
    });
    add('banner', 'Muestra el banner de un usuario', '>banner [@usuario]', { params: [userParam('usuario', false)] }, async (ctx, args) => {
        const user = await client.users.fetch(idOf(args[0] || ctx.user.id), { force: true });
        const url = user.bannerURL({ size: 1024 });
        if (!url) throw new UserError('Ese usuario no tiene un banner.');
        await ctx.reply({ embeds: [embed(`Banner de ${user.username}`, `[Abrir imagen](${url})`).setImage(url)] });
    });
    add('userinfo', 'Consulta un miembro', '>userinfo [@usuario]', { aliases: ['ui', 'whois'], params: [userParam('usuario', false)] }, async (ctx, args) => {
        const m = await getMember(ctx, args[0] || ctx.user.id);
        await ctx.reply({ embeds: [embed(m.user.username, `ID: ${m.id}\nCuenta: <t:${Math.floor(m.user.createdTimestamp / 1000)}:R>\nIngreso: ${m.joinedTimestamp ? `<t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : '—'}\nRoles: ${m.roles.cache.filter(r => r.id !== ctx.guild.id).map(r => `<@&${r.id}>`).slice(0, 20).join(' ') || 'Ninguno'}`).setThumbnail(m.user.displayAvatarURL())] });
    });
    add('serverinfo', 'Consulta el servidor', '>serverinfo', { aliases: ['si'] }, async ctx => {
        const g = ctx.guild;
        const e = embed(g.name, `ID: ${g.id}\nDueño: <@${g.ownerId}>\nMiembros: ${g.memberCount}\nBoosts: ${g.premiumSubscriptionCount || 0}`);
        if (g.iconURL()) e.setThumbnail(g.iconURL());
        await ctx.reply({ embeds: [e] });
    });
    add('sf', 'Muestra Spotify compartido en Discord', '>sf [@usuario]', { params: [userParam('usuario', false)] }, async (ctx, args) => {
        const m = await getMember(ctx, args[0] || ctx.user.id);
        const a = ctx.guild.presences.cache.get(m.id)?.activities.find(a => a.name === 'Spotify' && a.type === ActivityType.Listening);
        if (!a) throw new UserError('No detecto Spotify. Vincula tu cuenta y activa Mostrar Spotify como tu estado; evita el estado invisible.');
        const e = embed('🎧 Spotify', `${cut(a.details, 200)}\n**Artista:** ${cut(a.state, 500)}\n**Álbum:** ${cut(a.assets?.largeText, 500)}`)
            .setAuthor({ name: m.user.username, iconURL: m.user.displayAvatarURL() }).setColor(0x1db954);
        const image = a.assets?.largeImageURL(); if (image) e.setThumbnail(image);
        await ctx.reply({ embeds: [e] });
    });
    add('ask', 'Pregunta a la IA', '>ask <pregunta>', { guild: false, aliases: ['ia'], category: 'IA', params: [textParam('pregunta', 'Tu consulta (no compartas claves)')] }, async (ctx, args) => respondAI(ctx, args.join(' ')));
    add('forget', 'Borra tu contexto de IA de este chat', '>forget', { guild: false, category: 'IA', aliases: ['clearmem'], private: true }, async ctx => {
        ai.forget(aiKey(ctx)); await ctx.reply('Tu contexto de IA de este chat se ha borrado.');
    });
    add('privacy', 'Explica el uso de datos de IA y snipe', '>privacy', { guild: false, category: 'IA', private: true }, async ctx => ctx.reply('La IA envía tu consulta y hasta 6 turnos anteriores de esta conversación a Gemini. El contexto se guarda solo en RAM, caduca tras 2 horas sin uso y se borra al reiniciar o con >forget. No lee otros canales. Snipe es opcional, accesible al staff y conserva texto durante 5 minutos. Los tickets generan transcripciones privadas en el volumen; el administrador gestiona su retención.'));

    for (const name of ['welcome', 'goodbye']) add(name, name === 'welcome' ? 'Configura la bienvenida' : 'Configura la despedida', `>${name} #canal <mensaje> | off | test`, optConfig(), async (ctx, args) => {
        const cfg = store.guild(ctx.guild.id);
        if (args[0] === 'off') { cfg[name] = null; store.save(); return ctx.reply('Desactivado.'); }
        if (args[0] === 'test') {
            if (!cfg[name]) throw new UserError('Configura primero el canal y mensaje.');
            const ch = await getChannel(ctx, cfg[name].channelId);
            await ch.send({ content: render(cfg[name].text, ctx.member), allowedMentions: { users: [ctx.user.id] } });
            return ctx.reply('Mensaje de prueba enviado.');
        }
        const ch = await getChannel(ctx, args[0]);
        const body = args.slice(1).join(' ') || (name === 'welcome' ? '¡Bienvenido {user} a {server}! Ya somos {count}.' : '{username} salió de {server}.');
        if (body.length > 1800) throw new UserError('El mensaje admite hasta 1800 caracteres.');
        cfg[name] = { channelId: ch.id, text: body }; store.save();
        await ctx.reply('Guardado. Variables: {user}, {username}, {server}, {count}.');
    });
    add('autorole', 'Rol automático para nuevos miembros', '>autorole @rol | off', optConfig(P.ManageRoles), async (ctx, args) => {
        const cfg = store.guild(ctx.guild.id);
        if (args[0] === 'off') cfg.autorole = null;
        else {
            const role = await getRole(ctx, args[0]);
            safeRole(role, await botPermission(ctx, P.ManageRoles), ctx.member); cfg.autorole = role.id;
        }
        store.save(); await ctx.reply('Autorrol actualizado.');
    });
    for (const name of ['logs', 'djrole']) add(name, name === 'logs' ? 'Canal de registros' : 'Restringe controles al rol DJ', `>${name} ${name === 'logs' ? '#canal' : '@rol'} | off`, optConfig(), async (ctx, args) => {
        const cfg = store.guild(ctx.guild.id);
        const key = name === 'logs' ? 'logChannel' : 'djRole';
        cfg[key] = args[0] === 'off' ? null : (name === 'logs' ? await getChannel(ctx, args[0]) : await getRole(ctx, args[0])).id;
        store.save(); await ctx.reply('Configuración guardada.');
    });
    add('prefix', 'Cambia el prefijo del servidor', '>prefix <prefijo>', optConfig(), async (ctx, args) => {
        const p = args[0];
        if (!p || p.length > 3 || /[\s<>@/]/.test(p)) throw new UserError('Usa entre 1 y 3 caracteres, sin espacios, /, <, > o @. El prefijo > siempre sigue disponible.');
        store.guild(ctx.guild.id).prefix = p; store.save(); await ctx.reply(`Prefijo guardado: ${p}`);
    });
    for (const [name, key] of [['snipeconfig', 'snipe'], ['automod', 'automod'], ['aiconfig', 'ai']]) {
        add(name, `Activa o desactiva ${key}`, `>${name} on | off`, optConfig(), async (ctx, args) => {
            if (!['on', 'off'].includes(args[0])) throw new UserError(`Uso: >${name} on | off`);
            store.guild(ctx.guild.id)[key] = args[0] === 'on'; store.save();
            if (name === 'snipeconfig' && args[0] === 'off') {
                for (const ch of ctx.guild.channels.cache.values()) { snipes.delete(ch.id); edits.delete(ch.id); }
            }
            await ctx.reply(`${key}: ${args[0]}.`);
        });
    }
    add('knowledge', 'Guarda información para el asistente', '>knowledge <texto> | clear', optConfig(), async (ctx, args) => {
        const text = args.join(' ');
        if (text.length > 4000) throw new UserError('Máximo 4000 caracteres.');
        store.guild(ctx.guild.id).knowledge = text === 'clear' ? '' : text;
        store.save(); await ctx.reply('Información de soporte actualizada.');
    });
    add('config', 'Muestra la configuración actual', '>config', { permission: P.ManageGuild, category: 'Configuración', private: true }, async ctx => {
        const c = store.guild(ctx.guild.id);
        await ctx.reply({ embeds: [embed('Configuración', `Prefijo: ${c.prefix}\nBienvenida: ${c.welcome ? `<#${c.welcome.channelId}>` : 'off'}\nDespedida: ${c.goodbye ? `<#${c.goodbye.channelId}>` : 'off'}\nAutorrol: ${c.autorole ? `<@&${c.autorole}>` : 'off'}\nLogs: ${c.logChannel ? `<#${c.logChannel}>` : 'off'}\nSnipe: ${c.snipe}\nAntispam: ${c.automod}\nIA: ${c.ai}\nRespuestas: ${Object.keys(c.custom).length}\nReacciones: ${c.reactions.length}\nCategoría tickets: ${c.ticketCategory || 'sin configurar'}`)] });
    });
    add('autoreact', 'Reacciona a palabras o frases', '>autoreact add "frase" emoji | remove "frase" | list', optConfig(), async (ctx, args) => {
        const cfg = store.guild(ctx.guild.id);
        if (args[0] === 'list') return ctx.reply(cfg.reactions.map(r => `${r.trigger} → ${r.emoji}`).join('\n') || 'Sin reacciones.');
        const trigger = args[1]?.toLocaleLowerCase('es');
        if (!trigger || trigger.length > 80) throw new UserError('Indica una frase de hasta 80 caracteres. Usa comillas si contiene espacios.');
        if (args[0] === 'remove') cfg.reactions = cfg.reactions.filter(r => r.trigger !== trigger);
        else if (args[0] === 'add') {
            if (cfg.reactions.length >= 25) throw new UserError('Máximo 25 reacciones.');
            let emoji = args[2];
            if (!emoji || emoji.length > 100) throw new UserError('Indica un emoji.');
            const customId = emoji.match(/^<a?:\w+:(\d+)>$/)?.[1];
            if (customId) emoji = customId;
            const testMessage = await ctx.channel.send('Comprobando emoji…');
            try { await testMessage.react(emoji); }
            catch { throw new UserError('No puedo usar ese emoji. Revisa el emoji y Añadir reacciones.'); }
            finally { await testMessage.delete().catch(() => {}); }
            cfg.reactions = cfg.reactions.filter(r => r.trigger !== trigger);
            cfg.reactions.push({ trigger, emoji });
        } else throw new UserError('Usa add, remove o list.');
        store.save(); await ctx.reply('Reacciones actualizadas.');
    });
    add('responder', 'Crea respuestas a comandos', '>responder add nombre <texto> | remove nombre | list', optConfig(), async (ctx, args) => {
        const cfg = store.guild(ctx.guild.id);
        if (args[0] === 'list') return ctx.reply(Object.keys(cfg.custom).map(k => `>${k}`).join(', ') || 'Sin respuestas.');
        const name = args[1]?.toLowerCase();
        if (!/^[a-z0-9_-]{1,24}$/.test(name || '') || ['__proto__', 'constructor', 'prototype'].includes(name) || commands.has(name) || aliases.has(name)) throw new UserError('Nombre inválido o reservado.');
        if (args[0] === 'remove') delete cfg.custom[name];
        else if (args[0] === 'add') {
            const content = args.slice(2).join(' ');
            if (!content || content.length > 1800) throw new UserError('La respuesta debe tener de 1 a 1800 caracteres.');
            if (Object.keys(cfg.custom).length >= 50 && !Object.hasOwn(cfg.custom, name)) throw new UserError('Máximo 50 comandos personalizados.');
            cfg.custom[name] = content;
        } else throw new UserError('Usa add, remove o list.');
        store.save(); await ctx.reply('Respuesta guardada. Variables: {user}, {username}, {server}, {count}.');
    });
    add('rolebutton', 'Publica un botón para obtener un rol', '>rolebutton @rol <etiqueta>', optConfig(P.ManageRoles), async (ctx, args) => {
        const role = await getRole(ctx, args[0]);
        safeRole(role, await botPermission(ctx, P.ManageRoles), ctx.member);
        const label = cut(args.slice(1).join(' ') || role.name, 80);
        const sent = await ctx.channel.send({ embeds: [embed('Roles de la comunidad', `Pulsa para obtener o quitar **${role.name}**.`)],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tm:role:${role.id}`).setLabel(label).setStyle(ButtonStyle.Secondary))] });
        store.guild(ctx.guild.id).roleButtons[sent.id] = role.id; store.save(); await ctx.reply('Panel de rol creado.');
    });

    for (const [name, cache] of [['snipe', snipes], ['editsnipe', edits]]) add(name, name === 'snipe' ? 'Último texto eliminado (staff)' : 'Último texto editado (staff)', `>${name}`, { permission: P.ManageMessages, category: 'Moderación', private: true, aliases: name === 'snipe' ? ['s'] : ['es'] }, async ctx => {
        if (!store.guild(ctx.guild.id).snipe) throw new UserError('Snipe está desactivado. Un administrador puede usar >snipeconfig on.');
        const entry = cache.get(ctx.channel.id);
        if (!entry) throw new UserError('No hay un texto registrado en los últimos 5 minutos.');
        await ctx.reply({ embeds: [embed(`${name} • ${entry.author}`, entry.text).setFooter({ text: 'Caduca a los 5 minutos. No se guarda en disco.' })] });
    });
    add('purge', 'Borra mensajes recientes', '>purge <1-100>', { aliases: ['clear', 'c'], permission: P.ManageMessages, category: 'Moderación', private: true, params: [numParam('cantidad', 'Cantidad de mensajes', 1, 100)] }, async (ctx, args) => {
        await botPermission(ctx, P.ManageMessages);
        const count = integer(args[0], 1, 100);
        const deleted = await ctx.channel.bulkDelete(count, true);
        await ctx.reply(`Borrados ${deleted.size} mensajes. Los antiguos que Discord no permite borrar en lote se omiten.`);
        await log(ctx.guild, 'Limpieza', `${ctx.user.id}: ${deleted.size} mensajes en ${ctx.channel.id}.`);
    });
    add('timeout', 'Aplica un timeout con motivo', '>timeout @usuario 10m <motivo>', { permission: P.ModerateMembers, category: 'Moderación', params: [userParam(), textParam('duracion', 'Ej.: 10m, 2h, 1d'), textParam('motivo', 'Motivo de la sanción')] }, async (ctx, args) => {
        const target = await modTarget(ctx, args[0], P.ModerateMembers);
        const ms = duration(args[1]); const reason = args.slice(2).join(' ');
        if (!reason) throw new UserError('Indica un motivo.');
        if (!target.moderatable) throw new UserError('Discord no permite aislar a este miembro. No se quitarán sus roles.');
        await target.timeout(ms, cut(`${ctx.user.id}: ${reason}`, 500));
        await ctx.reply(`Timeout aplicado a ${target.user.username} durante ${args[1]}.`);
        await log(ctx.guild, 'Timeout', `${ctx.user.id} → ${target.id}: ${cut(reason, 500)} (${args[1]})`);
    });
    add('untimeout', 'Retira un timeout', '>untimeout @usuario', { permission: P.ModerateMembers, category: 'Moderación', params: [userParam()] }, async (ctx, args) => {
        const target = await modTarget(ctx, args[0], P.ModerateMembers);
        if (!target.moderatable) throw new UserError('No puedo moderar ese miembro.');
        await target.timeout(null, `Solicitado por ${ctx.user.id}`); await ctx.reply('Timeout retirado.');
        await log(ctx.guild, 'Timeout retirado', `${ctx.user.id} → ${target.id}`);
    });
    for (const name of ['kick', 'ban']) add(name, name === 'kick' ? 'Expulsa a un miembro' : 'Banea a un miembro', `>${name} @usuario <motivo>`, { permission: name === 'kick' ? P.KickMembers : P.BanMembers, category: 'Moderación', params: [userParam(), textParam('motivo', 'Motivo de la sanción')] }, async (ctx, args) => {
        const target = await modTarget(ctx, args[0], name === 'kick' ? P.KickMembers : P.BanMembers);
        const reason = args.slice(1).join(' '); if (!reason) throw new UserError('Indica un motivo.');
        if (name === 'kick' && !target.kickable || name === 'ban' && !target.bannable) throw new UserError('Discord no permite esa acción sobre el miembro.');
        if (name === 'kick') await target.kick(cut(`${ctx.user.id}: ${reason}`, 500));
        else await target.ban({ reason: cut(`${ctx.user.id}: ${reason}`, 500) });
        await ctx.reply(`${name === 'kick' ? 'Expulsado' : 'Baneado'}: ${target.user.username}.`);
        await log(ctx.guild, name, `${ctx.user.id} → ${target.id}: ${cut(reason, 500)}`);
    });
    add('warn', 'Guarda una advertencia', '>warn @usuario <motivo>', { permission: P.ModerateMembers, category: 'Moderación', params: [userParam(), textParam('motivo', 'Motivo de la advertencia')] }, async (ctx, args) => {
        const target = await modTarget(ctx, args[0], P.ModerateMembers);
        const reason = args.slice(1).join(' '); if (!reason) throw new UserError('Indica un motivo.');
        const entry = store.warn(ctx.guild.id, target.id, ctx.user.id, reason);
        await ctx.reply(`Advertencia ${entry.id} guardada para ${target.user.username}.`);
        await log(ctx.guild, 'Advertencia', `${ctx.user.id} → ${target.id}: ${entry.reason}`);
    });
    add('warnings', 'Consulta advertencias', '>warnings @usuario', { permission: P.ModerateMembers, category: 'Moderación', private: true, params: [userParam()] }, async (ctx, args) => {
        const target = await getMember(ctx, args[0]);
        const list = store.guild(ctx.guild.id).warnings[target.id] || [];
        await ctx.reply({ embeds: [embed(`Advertencias: ${target.user.username}`, list.slice(-10).map(w => `${w.id} • ${w.reason} • <@${w.moderator}>`).join('\n') || 'Sin advertencias.')] });
    });
    add('clearwarn', 'Elimina una advertencia por ID', '>clearwarn @usuario <id>', { permission: P.ModerateMembers, category: 'Moderación', params: [userParam(), textParam('id', 'ID de la advertencia')] }, async (ctx, args) => {
        const target = await getMember(ctx, args[0]);
        const cfg = store.guild(ctx.guild.id); const list = cfg.warnings[target.id] || [];
        if (!list.some(w => w.id === args[1])) throw new UserError('Advertencia no encontrada.');
        cfg.warnings[target.id] = list.filter(w => w.id !== args[1]); store.save();
        await ctx.reply('Advertencia eliminada.'); await log(ctx.guild, 'Advertencia eliminada', `${ctx.user.id} → ${target.id}: ${args[1]}`);
    });
    add('role', 'Añade o quita un rol sin privilegios', '>role @usuario @rol add|remove', { permission: P.ManageRoles, category: 'Moderación', params: [userParam(), { type: 8, name: 'rol', description: 'Rol sin privilegios', required: true }, textParam('accion', 'add o remove')] }, async (ctx, args) => {
        const target = await getMember(ctx, args[0]); const role = await getRole(ctx, args[1]);
        const me = await botPermission(ctx, P.ManageRoles); safeRole(role, me, ctx.member);
        if (target.id !== ctx.user.id) requireHierarchy(ctx.member, target, me);
        if (!['add', 'remove'].includes(args[2])) throw new UserError('Usa add o remove.');
        await target.roles[args[2]](role, `Solicitado por ${ctx.user.id}`);
        await ctx.reply('Rol actualizado.'); await log(ctx.guild, 'Rol actualizado', `${ctx.user.id}: ${args[2]} ${role.id} → ${target.id}`);
    });
    for (const name of ['lock', 'unlock']) add(name, name === 'lock' ? 'Bloquea el canal para @everyone' : 'Restaura el permiso anterior', `>${name}`, { permission: P.ManageChannels, category: 'Moderación' }, async ctx => {
        await botPermission(ctx, P.ManageRoles);
        const cfg = store.guild(ctx.guild.id); cfg.locks ||= {};
        if (name === 'lock') {
            if (Object.hasOwn(cfg.locks, ctx.channel.id)) throw new UserError('Este canal ya tiene un bloqueo registrado.');
            const overwrite = ctx.channel.permissionOverwrites.cache.get(ctx.guild.id);
            const previous = overwrite?.allow.has(P.SendMessages) ? true : overwrite?.deny.has(P.SendMessages) ? false : null;
            await ctx.channel.permissionOverwrites.edit(ctx.guild.id, { SendMessages: false });
            cfg.locks[ctx.channel.id] = previous;
        } else {
            if (!Object.hasOwn(cfg.locks, ctx.channel.id)) throw new UserError('No hay un bloqueo registrado para restaurar.');
            await ctx.channel.permissionOverwrites.edit(ctx.guild.id, { SendMessages: cfg.locks[ctx.channel.id] });
            delete cfg.locks[ctx.channel.id];
        }
        store.save(); await ctx.reply(name === 'lock' ? 'Canal bloqueado para @everyone. Los permisos explícitos de otros roles pueden permitir escribir.' : 'Permiso anterior restaurado.');
        await log(ctx.guild, name, `${ctx.user.id} en ${ctx.channel.id}`);
    });
    add('slowmode', 'Configura el modo lento', '>slowmode <0-21600>', { permission: P.ManageChannels, category: 'Moderación', params: [numParam('segundos', '0 para desactivar', 0, 21600)] }, async (ctx, args) => {
        await botPermission(ctx, P.ManageChannels);
        await ctx.channel.setRateLimitPerUser(integer(args[0], 0, 21600)); await ctx.reply('Modo lento actualizado.');
    });
    add('say', 'Publica un texto con el bot', '>say <texto>', { permission: P.ManageMessages, category: 'Moderación', private: true, params: [textParam('texto', 'Mensaje para este canal')] }, async (ctx, args) => {
        const body = args.join(' '); if (!body || body.length > 1900) throw new UserError('Usa de 1 a 1900 caracteres.');
        await ctx.channel.send({ content: body, allowedMentions: { parse: [] } });
        await ctx.reply('Mensaje enviado.'); await log(ctx.guild, 'Mensaje del bot', `Solicitado por ${ctx.user.id} en ${ctx.channel.id}.`);
    });

    add('ticketsetup', 'Configura categoría y rol de soporte', '>ticketsetup <id-categoría> @soporte', optConfig(P.ManageChannels), async (ctx, args) => {
        const parent = await getChannel(ctx, args[0], true); const role = await getRole(ctx, args[1]);
        if (role.id === ctx.guild.id || role.managed) throw new UserError('Usa un rol específico de soporte.');
        const cfg = store.guild(ctx.guild.id); cfg.ticketCategory = parent.id; cfg.supportRole = role.id;
        store.save(); await ctx.reply('Tickets configurados. Usa >ticketpanel en el canal donde quieras el panel.');
    });
    add('ticketpanel', 'Publica el panel de tickets', '>ticketpanel', { permission: P.ManageChannels, category: 'Tickets', aliases: ['ticket', 'tickets'] }, async ctx => {
        const cfg = store.guild(ctx.guild.id);
        if (!cfg.ticketCategory || !cfg.supportRole) throw new UserError('Primero usa >ticketsetup <id-categoría> @soporte.');
        await tickets.panel(ctx.channel); await ctx.reply('Panel publicado.');
    });
    add('close', 'Muestra confirmación para cerrar el ticket', '>close', { category: 'Tickets', aliases: ['cerrar'] }, async ctx => {
        const ticket = tickets.get(ctx.channel.id);
        if (!ticket || (ticket.ownerId !== ctx.user.id && !tickets.staff(ctx.member, store.guild(ctx.guild.id)))) throw new UserError('Solo el autor o soporte pueden cerrar un ticket registrado.');
        await ctx.reply({ content: 'Confirma para guardar la transcripción y eliminar este canal.',
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tm:ticket:confirm:${ctx.user.id}`).setLabel('Cerrar ticket').setStyle(ButtonStyle.Danger))] });
    });
    add('transcript', 'Descarga la transcripción del ticket', '>transcript', { category: 'Tickets', private: true }, async ctx => {
        const ticket = tickets.get(ctx.channel.id);
        if (!ticket || (ticket.ownerId !== ctx.user.id && !tickets.staff(ctx.member, store.guild(ctx.guild.id)))) throw new UserError('Solo el autor o soporte pueden exportar este ticket.');
        await ctx.reply({ files: [new AttachmentBuilder(await tickets.transcript(ctx.channel), { name: `ticket-${ctx.channel.id}.txt` })] });
    });

    const musicOptions = { category: 'Música' };
    add('join', 'Conecta al canal de voz', '>join', musicOptions, async ctx => { await music.join(ctx); await ctx.reply('Conectado al canal de voz.'); });
    add('play', 'Busca y reproduce una canción', '>play <nombre o enlace>', { ...musicOptions, aliases: ['p'], params: [textParam('cancion', 'Nombre con artista, YouTube o canción de Spotify')] }, async (ctx, args) => {
        const track = await music.play(ctx, args.join(' '));
        await ctx.reply(`Solicitud procesada: **${track.title}**. El reproductor publicará el inicio o el error en este canal.`);
    });
    for (const name of ['stop', 'skip', 'pause', 'resume', 'shuffle']) add(name, { stop: 'Detiene y desconecta', skip: 'Salta la pista', pause: 'Pausa la música', resume: 'Reanuda la música', shuffle: 'Mezcla la cola' }[name], `>${name}`, { ...musicOptions, aliases: name === 'stop' ? ['leave', 'disconnect'] : name === 'skip' ? ['next'] : [] }, async ctx => {
        await music.action(ctx, name); await ctx.reply(`✅ ${name}`);
    });
    add('volume', 'Ajusta el volumen de 0 a 100', '>volume <0-100>', { ...musicOptions, aliases: ['vol'], params: [numParam('porcentaje', 'Volumen', 0, 100)] }, async (ctx, args) => {
        const n = integer(args[0], 0, 100); await music.action(ctx, 'volume', n); await ctx.reply(`Volumen: ${n}%.`);
    });
    add('loop', 'Cambia el modo de repetición', '>loop off|song|queue', { ...musicOptions, params: [textParam('modo', 'off, song o queue')] }, async (ctx, args) => {
        if (!['off', 'song', 'queue'].includes(args[0])) throw new UserError('Usa off, song o queue.');
        await music.action(ctx, 'loop', args[0]); await ctx.reply(`Repetición: ${args[0]}.`);
    });
    add('queue', 'Muestra las siguientes canciones', '>queue', { ...musicOptions, aliases: ['q'] }, async ctx => {
        const s = music.sessions.get(ctx.guild.id);
        await ctx.reply({ embeds: [embed('Cola musical', `**Actual:** ${s?.current?.track.title || 'Ninguna'}\n\n${s?.queue.slice(0, 15).map((t, i) => `${i + 1}. ${t.title}`).join('\n') || 'Cola vacía.'}`)] });
    });
    add('nowplaying', 'Muestra la pista actual', '>nowplaying', { ...musicOptions, aliases: ['np'] }, async ctx => {
        const s = music.sessions.get(ctx.guild.id);
        if (!s?.current) throw new UserError('No hay música activa.');
        await ctx.reply({ embeds: [embed('Ahora', `${s.current.track.title}\nEstado: ${s.player.state.status}\nVolumen: ${Math.round(s.volume * 100)}%`)] });
    });
    add('audiotest', 'Prueba la voz con un tono suave', '>audiotest', musicOptions, async ctx => {
        await music.test(ctx); await ctx.reply('Prueba enviada. Si no la oyes, revisa >musicdiag.');
    });
    add('musicdiag', 'Diagnóstico de la sesión de audio', '>musicdiag', { ...musicOptions, private: true }, async ctx => ctx.reply({ embeds: [embed('Diagnóstico de audio', music.diagnostic(ctx.guild))] }));

    function slashDefinitions() {
        return definitions.map(d => ({ name: d.name, description: d.description.slice(0, 100),
            default_member_permissions: d.permission ? d.permission.toString() : null,
            contexts: d.guild ? [0] : [0, 1], integration_types: [0], options: d.params }));
    }
    async function makeContext(source, isSlash = false) {
        const guild = source.guild;
        const user = isSlash ? source.user : source.author;
        const member = guild ? await guild.members.fetch(user.id) : null;
        let replied = false;
        return { guild, member, user, channel: source.channel, source, isSlash,
            async reply(payload) {
                const data = typeof payload === 'string' ? { content: payload } : payload;
                if (isSlash) {
                    if (!replied) { replied = true; return source.editReply(data); }
                    return source.followUp(data);
                }
                return source.channel.send({ ...data, allowedMentions: data.allowedMentions || { parse: [], repliedUser: false } });
            }
        };
    }
    async function execute(ctx, name, args) {
        if (stopping) return;
        const actual = aliases.get(name) || name;
        const d = commands.get(actual);
        if (!d) {
            if (ctx.guild && Object.hasOwn(store.guild(ctx.guild.id).custom, name)) {
                await ctx.reply(render(store.guild(ctx.guild.id).custom[name], ctx.member));
            }
            return;
        }
        if (d.guild && !ctx.guild) throw new UserError('Este comando solo funciona dentro de un servidor.');
        if (ctx.guild && ctx.channel.isThread?.() && !['help', 'ping', 'ask', 'forget', 'privacy'].includes(actual)) throw new UserError('Usa este comando en un canal de texto normal.');
        if (d.permission) requirePermission(ctx.member, d.permission);
        const key = `${ctx.guild?.id || 'dm'}:${ctx.user.id}`;
        if (cooldown.get(key)) throw new UserError('Espera un momento antes del siguiente comando.');
        cooldown.set(key, true);
        return d.handler(ctx, args);
    }
    async function reportError(source, error, isInteraction = false) {
        const safe = error instanceof UserError ? error.message : 'La operación falló. Revisa los permisos del bot y los logs.';
        if (!(error instanceof UserError)) console.error('[ERROR]', error.code || '', error.message?.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 1000));
        const data = { content: `❌ ${safe}`, allowedMentions: { parse: [], repliedUser: false } };
        try {
            if (isInteraction) {
                if (source.deferred || source.replied) await source.editReply(data);
                else await source.reply({ ...data, flags: MessageFlags.Ephemeral });
            } else await source.channel.send(data);
        } catch { /* Puede haberse eliminado el canal o cerrado el DM. */ }
    }
    async function autoModerate(message) {
        const cfg = store.guild(message.guild.id);
        if (!cfg.automod || !message.member || checkStaff(message.member) || message.author.bot) return false;
        const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
        const times = (spam.get(key) || []).filter(t => Date.now() - t < 5000);
        times.push(Date.now()); spam.set(key, times);
        if (times.length < 6) return false;
        await message.delete().catch(() => {});
        const sanctionKey = `${message.guild.id}:${message.author.id}`;
        if (autoSanctions.get(sanctionKey)) return true;
        autoSanctions.set(sanctionKey, true);
        let result = 'Se detectó spam; no fue posible aplicar timeout.';
        if (message.member.moderatable && message.guild.members.me?.permissions.has(P.ModerateMembers)) {
            try { await message.member.timeout(60000, 'Antispam: 6 mensajes en 5 segundos'); result = 'Timeout de 1 minuto aplicado.'; } catch {}
        }
        await log(message.guild, 'Antispam', `${message.author.id} en ${message.channel.id}. ${result}`);
        return true;
    }
    client.on('messageCreate', async message => {
        if (message.author.bot || message.webhookId || stopping) return;
        try {
            if (message.guild && await autoModerate(message)) return;
            const cfg = message.guild ? store.guild(message.guild.id) : null;
            const prefixes = [...new Set([cfg?.prefix, process.env.PREFIX, '>', ','].filter(Boolean))].sort((a, b) => b.length - a.length);
            const prefix = prefixes.find(p => message.content.startsWith(p));
            if (prefix) {
                const args = tokenize(message.content.slice(prefix.length).trim());
                const name = args.shift()?.toLowerCase(); if (!name) return;
                const ctx = await makeContext(message);
                await execute(ctx, name, args); return;
            }
            if (!message.guild) {
                if (!message.content.trim()) return message.channel.send('Por ahora puedo leer texto. Escribe tu consulta o >help.');
                await message.channel.sendTyping().catch(() => {});
                await respondAI(await makeContext(message), message.content); return;
            }
            if (cfg.reactions.length && !reactionCooldown.get(`${message.guild.id}:${message.author.id}`)) {
                const matches = cfg.reactions.filter(r => message.content.toLocaleLowerCase('es').includes(r.trigger)).slice(0, 3);
                if (matches.length) reactionCooldown.set(`${message.guild.id}:${message.author.id}`, true);
                for (const rule of matches) await message.react(rule.emoji).catch(() => {});
            }
            const mention = new RegExp(`<@!?${client.user.id}>`, 'g');
            const directlyMentioned = message.content.match(mention);
            const ticket = tickets.get(message.channel.id);
            if (directlyMentioned || ticket?.aiActive && ticket.ownerId === message.author.id) {
                const text = message.content.replace(mention, '').trim();
                if (!text) return message.channel.send('Escribe tu pregunta o usa >help. La IA de esta versión responde texto.');
                await message.channel.sendTyping().catch(() => {});
                await respondAI(await makeContext(message), text);
            }
        } catch (error) { await reportError(message, error); }
    });
    client.on('interactionCreate', async interaction => {
        try {
            if (await tickets.handle(interaction)) return;
            if (interaction.isButton() && interaction.customId.startsWith('tm:role:')) {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                if (!interaction.guild) throw new UserError('Solo funciona en el servidor.');
                const cfg = store.guild(interaction.guildId);
                const roleId = interaction.customId.split(':')[2];
                if (cfg.roleButtons[interaction.message.id] !== roleId) throw new UserError('Este panel ya no está registrado.');
                const role = await interaction.guild.roles.fetch(roleId);
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const me = await interaction.guild.members.fetchMe();
                requirePermission(me, P.ManageRoles); safeRole(role, me);
                const remove = member.roles.cache.has(roleId);
                await member.roles[remove ? 'remove' : 'add'](role, 'Panel de roles voluntario');
                await interaction.editReply({ content: remove ? 'Rol retirado.' : 'Rol añadido.' }); return;
            }
            if (!interaction.isChatInputCommand()) return;
            const d = commands.get(interaction.commandName);
            if (!d) return interaction.reply({ content: 'Comando antiguo. Vuelve a abrir el menú / y usa /help.', flags: MessageFlags.Ephemeral });
            await interaction.deferReply(d.private ? { flags: MessageFlags.Ephemeral } : {});
            const args = [];
            for (const p of d.params) {
                const value = interaction.options.get(p.name)?.value;
                if (value !== undefined && value !== null) {
                    if (p.name === 'opciones') args.push(...tokenize(String(value)));
                    else args.push(String(value));
                }
            }
            await execute(await makeContext(interaction, true), d.name, args);
        } catch (error) { await reportError(interaction, error, true); }
    });
    client.on('guildMemberAdd', async member => {
        try {
            const cfg = store.guild(member.guild.id);
            if (cfg.autorole && !member.user.bot) {
                try {
                    const role = await member.guild.roles.fetch(cfg.autorole);
                    const me = await member.guild.members.fetchMe();
                    requirePermission(me, P.ManageRoles); safeRole(role, me);
                    await member.roles.add(role, 'Autorrol de bienvenida');
                } catch (error) { console.error('[AUTOROLE]', error.message); }
            }
            if (cfg.welcome) {
                const channel = await member.guild.channels.fetch(cfg.welcome.channelId);
                await channel.send({ content: render(cfg.welcome.text, member), allowedMentions: { users: [member.id] } });
            }
            await log(member.guild, 'Miembro nuevo', `${member.user.username} (${member.id})`);
        } catch (error) { console.error('[WELCOME]', error.message); }
    });
    client.on('guildMemberRemove', async member => {
        try {
            const cfg = store.guild(member.guild.id);
            if (cfg.goodbye) {
                const channel = await member.guild.channels.fetch(cfg.goodbye.channelId);
                await channel.send({ content: render(cfg.goodbye.text, member), allowedMentions: { parse: [] } });
            }
            await log(member.guild, 'Miembro salió', `${member.id}`);
        } catch (error) { console.error('[GOODBYE]', error.message); }
    });
    client.on('messageDelete', message => {
        if (!message.guild || !message.author || message.author.bot || !message.content || !store.guild(message.guild.id).snipe) return;
        snipes.set(message.channel.id, { author: message.author.username, text: cut(message.content, 3500) });
    });
    client.on('messageUpdate', (old, next) => {
        if (!old.guild || !old.author || old.author.bot || !old.content || old.content === next.content || !store.guild(old.guild.id).snipe) return;
        edits.set(old.channel.id, { author: old.author.username, text: `**Antes:**\n${cut(old.content, 1700)}\n\n**Después:**\n${cut(next.content, 1700)}` });
    });
    client.on('channelDelete', channel => {
        snipes.delete(channel.id); edits.delete(channel.id);
        if (store.data.tickets[channel.id]) { delete store.data.tickets[channel.id]; store.save(); }
    });
    const emptyVoiceTimers = new Map();
    client.on('voiceStateUpdate', (old, next) => {
        const s = music.sessions.get(next.guild.id); if (!s) return;
        if (next.id === client.user.id && next.channelId !== s.voiceId) {
            music.serial.run(s.guildId, () => music._destroy(s)).catch(console.error); return;
        }
        const channel = next.guild.channels.cache.get(s.voiceId);
        if (!channel) return;
        if (channel.members.some(m => !m.user.bot)) {
            clearTimeout(emptyVoiceTimers.get(s.guildId)); emptyVoiceTimers.delete(s.guildId); return;
        }
        if (emptyVoiceTimers.has(s.guildId)) return;
        const timer = setTimeout(() => {
            emptyVoiceTimers.delete(s.guildId);
            music.serial.run(s.guildId, () => {
                if (music.sessions.get(s.guildId) === s && !channel.members.some(m => !m.user.bot)) music._destroy(s);
            }).catch(console.error);
        }, 30000); timer.unref(); emptyVoiceTimers.set(s.guildId, timer);
    });
    client.on('error', error => console.error('[CLIENT]', error.message));
    client.once('clientReady', async () => {
        console.log(`✅ Timmy Max v3 conectado como ${client.user.tag}`);
        console.log(`🧠 Archivo de memoria: ${store.file}`);
        if (process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('⚠️ Conecta un volumen /data para conservar los datos.');
        console.log(generateDependencyReport());
        client.user.setPresence({ activities: [{ name: '>help • Soporte, comunidad y música', type: ActivityType.Listening }], status: 'online' });
        if (process.env.REGISTER_SLASH !== 'false') {
            try {
                await client.application.commands.set(slashDefinitions());
                if (process.env.GUILD_ID) {
                    const guild = await client.guilds.fetch(process.env.GUILD_ID);
                    const local = slashDefinitions().map(({ contexts, integration_types, ...d }) => d);
                    await guild.commands.set(local);
                }
                console.log(`✅ ${definitions.length} comandos / registrados.`);
            } catch (error) { console.error('[SLASH] Revisa GUILD_ID e invitación con applications.commands:', error.message); }
        }
    });
    async function shutdown() {
        if (stopping) return;
        stopping = true;
        for (const timer of emptyVoiceTimers.values()) clearTimeout(timer);
        music.closeAll(); store.save(); await client.destroy();
    }
    return { client, store, music, ai, tickets, commands, definitions, slashDefinitions, execute, shutdown };
}
if (require.main === module) {
    if (!process.env.DISCORD_TOKEN) {
        console.error('Falta DISCORD_TOKEN en Variables de Railway o .env.'); process.exit(1);
    }
    const app = buildBot();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        app.shutdown().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
    });
    process.on('unhandledRejection', error => {
        console.error('[FATAL]', error?.message || 'Promesa no atendida');
        app.shutdown().finally(() => process.exit(1));
    });
    app.client.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error('No se pudo iniciar Discord:', error.message); process.exit(1);
    });
}
module.exports = { buildBot };
