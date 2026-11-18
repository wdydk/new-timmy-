'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, AttachmentBuilder, MessageFlags
} = require('discord.js');
const { UserError, Serial, cut } = require('./core');
const { P } = require('./permissions');
const CATEGORIES = { soporte: 'Dudas / soporte', reporte: 'Reportar a un usuario', recompensa: 'Reclamar recompensa', postulacion: 'Postulación a staff' };
class Tickets {
    constructor(client, store, log) {
        this.client = client; this.store = store; this.log = log; this.serial = new Serial();
        this.directory = path.join(store.directory, 'transcripts');
        fs.mkdirSync(this.directory, { recursive: true });
    }
    get(channelId) { return this.store.data.tickets[channelId]; }
    staff(member, cfg) { return member.permissions.has(P.ManageChannels) || Boolean(cfg.supportRole && member.roles.cache.has(cfg.supportRole)); }
    async panel(channel) {
        const menu = new StringSelectMenuBuilder().setCustomId('tm:ticket:open').setPlaceholder('Selecciona el motivo')
            .addOptions(Object.entries(CATEGORIES).map(([value, label]) => ({ label, value })));
        await channel.send({ embeds: [new EmbedBuilder().setColor(0x7c83ff).setTitle('Soporte • Timmy Max')
            .setDescription('Abre un ticket privado para recibir ayuda. Describe el problema y adjunta pruebas si hace falta.\n\nLa IA puede ayudar; las decisiones de moderación corresponden al staff.')],
        components: [new ActionRowBuilder().addComponents(menu)] });
    }
    row(ticket) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tm:ticket:claim').setLabel('Atender').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tm:ticket:ai').setLabel(ticket.aiActive ? 'IA activa' : 'IA pausada').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tm:ticket:transcript').setLabel('Transcripción').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('tm:ticket:close').setLabel('Cerrar').setStyle(ButtonStyle.Danger)
        );
    }
    async transcript(channel) {
        const messages = [];
        let before;
        for (let page = 0; page < 10; page++) {
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
            messages.push(...batch.values());
            if (batch.size < 100) break;
            before = batch.last().id;
        }
        const body = [
            `Ticket ${channel.id} | ${channel.name}`,
            `Exportado ${new Date().toISOString()}. Máximo: últimos 1000 mensajes.`,
            'Los enlaces de adjuntos pueden caducar. Guarda las pruebas importantes por separado.', ''
        ];
        for (const m of messages.reverse()) {
            body.push(`[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag} (${m.author.id})`, m.content || '');
            for (const embed of m.embeds) body.push(embed.title || '', embed.description || '', ...embed.fields.map(f => `${f.name}: ${f.value}`));
            for (const attachment of m.attachments.values()) body.push(`Adjunto: ${attachment.name} ${attachment.url}`);
            body.push('');
        }
        return Buffer.from(body.join('\n'), 'utf8');
    }
    async open(interaction, category) {
        const guild = interaction.guild;
        const cfg = this.store.guild(guild.id);
        const key = `${guild.id}:${interaction.user.id}`;
        return this.serial.run(key, async () => {
            if (!cfg.ticketCategory || !cfg.supportRole) throw new UserError('El staff debe ejecutar >ticketsetup primero.');
            const parent = await guild.channels.fetch(cfg.ticketCategory).catch(() => null);
            const support = await guild.roles.fetch(cfg.supportRole).catch(() => null);
            if (!parent || parent.type !== ChannelType.GuildCategory || !support || support.id === guild.id) throw new UserError('La categoría o rol de soporte ya no existe. Repite >ticketsetup.');
            for (const [channelId, ticket] of Object.entries(this.store.data.tickets)) {
                if (ticket.guildId !== guild.id || ticket.ownerId !== interaction.user.id) continue;
                const exists = await guild.channels.fetch(channelId).catch(error => {
                    if (error.code === 10003) return null;
                    throw error;
                });
                if (exists) throw new UserError(`Ya tienes un ticket: <#${channelId}>.`);
                delete this.store.data.tickets[channelId];
            }
            const me = await guild.members.fetchMe();
            if (!me.permissions.has(P.ManageChannels)) throw new UserError('Necesito Gestionar canales para crear tickets.');
            const summary = interaction.fields.getTextInputValue('detail');
            const channel = await guild.channels.create({
                name: `ticket-${interaction.user.username.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'usuario'}`,
                type: ChannelType.GuildText, parent: parent.id,
                permissionOverwrites: [
                    { id: guild.id, deny: [P.ViewChannel] },
                    { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks] },
                    { id: support.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
                    { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.AttachFiles, P.EmbedLinks] }
                ], reason: 'Ticket solicitado por el usuario'
            });
            const ticket = { guildId: guild.id, ownerId: interaction.user.id, category, summary,
                claimedBy: null, aiActive: true, createdAt: Date.now() };
            this.store.data.tickets[channel.id] = ticket;
            this.store.save();
            const first = await channel.send({ content: `<@${interaction.user.id}> <@&${support.id}>`,
                allowedMentions: { users: [interaction.user.id], roles: [support.id] },
                embeds: [new EmbedBuilder().setColor(0x7c83ff).setTitle(CATEGORIES[category]).setDescription(cut(summary, 1000))
                    .setFooter({ text: 'Escribe tu consulta. La IA está activa; el staff puede pausarla.' })],
                components: [this.row(ticket)]
            });
            ticket.messageId = first.id; this.store.save();
            await interaction.editReply({ content: `🎫 Ticket creado: <#${channel.id}>` });
            await this.log(guild, 'Ticket abierto', `${interaction.user.id} → ${channel.id} (${category})`);
        });
    }
    async handle(interaction) {
        if (!interaction.customId?.startsWith('tm:ticket:')) return false;
        if (!interaction.guild) throw new UserError('Los tickets se usan en un servidor.');
        if (interaction.isStringSelectMenu() && interaction.customId === 'tm:ticket:open') {
            const category = interaction.values[0];
            if (!CATEGORIES[category]) throw new UserError('Categoría no válida.');
            const modal = new ModalBuilder().setCustomId(`tm:ticket:form:${category}`).setTitle(CATEGORIES[category]);
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('detail')
                .setLabel('Tu solicitud y usuario de Roblox (si aplica)')
                .setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setMinLength(5).setRequired(true)));
            await interaction.showModal(modal); return true;
        }
        if (interaction.isModalSubmit()) {
            const category = interaction.customId.split(':')[3];
            if (!CATEGORIES[category]) throw new UserError('Categoría no válida.');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await this.open(interaction, category); return true;
        }
        if (!interaction.isButton()) return true;
        const ticket = this.get(interaction.channelId);
        if (!ticket || ticket.guildId !== interaction.guildId) throw new UserError('Este canal no es un ticket registrado.');
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const staff = this.staff(member, this.store.guild(interaction.guildId));
        const owner = ticket.ownerId === member.id;
        if (!staff && !owner) throw new UserError('Solo el autor y soporte pueden gestionar este ticket.');
        const action = interaction.customId.split(':')[2];
        if (action === 'close') {
            await interaction.reply({ content: '¿Cerrar el ticket? Se guardará una transcripción privada y se eliminará este canal.',
                flags: MessageFlags.Ephemeral,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tm:ticket:confirm:${member.id}`)
                    .setLabel('Confirmar cierre').setStyle(ButtonStyle.Danger))] });
            return true;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (action === 'transcript') {
            const body = await this.transcript(interaction.channel);
            await interaction.editReply({ files: [new AttachmentBuilder(body, { name: `ticket-${interaction.channelId}.txt` })] });
        } else if (action === 'claim' || action === 'ai') {
            if (!staff) throw new UserError('Solo soporte puede hacer eso.');
            if (action === 'claim') {
                if (ticket.claimedBy && ticket.claimedBy !== member.id) throw new UserError(`Ya lo atiende <@${ticket.claimedBy}>.`);
                ticket.claimedBy = member.id; ticket.aiActive = false;
            } else ticket.aiActive = !ticket.aiActive;
            this.store.save();
            const first = await interaction.channel.messages.fetch(ticket.messageId).catch(() => null);
            if (first) await first.edit({ components: [this.row(ticket)] });
            await interaction.editReply({ content: action === 'claim' ? 'Ticket asignado a ti. IA pausada.' : `IA ${ticket.aiActive ? 'activada' : 'pausada'}.` });
            if (action === 'claim') await interaction.channel.send(`🙋 <@${member.id}> atenderá tu ticket.`);
        } else if (action === 'confirm') {
            if (interaction.customId.split(':')[3] !== member.id) throw new UserError('Esta confirmación pertenece a otra persona.');
            await this.serial.run(interaction.channelId, async () => {
                if (!this.get(interaction.channelId)) throw new UserError('El ticket ya está cerrado.');
                const body = await this.transcript(interaction.channel);
                fs.writeFileSync(path.join(this.directory, `${interaction.channelId}.txt`), body, { mode: 0o600 });
                await interaction.editReply({ content: 'Transcripción guardada. Cerrando el canal…' });
                await interaction.channel.delete(`Ticket cerrado por ${member.id}`);
                delete this.store.data.tickets[interaction.channelId]; this.store.save();
                await this.log(interaction.guild, 'Ticket cerrado', `Canal ${interaction.channelId}; cerrado por ${member.id}. Transcripción en el volumen.`);
            });
        }
        return true;
    }
}
module.exports = { Tickets };
