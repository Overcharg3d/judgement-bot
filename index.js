'use strict';

// ============================================================
// index.js - Court Bot Part 1
// Core infrastructure, DB, helpers, setup wizard,
// case filing/management, judge commands, and punishment engine
// ============================================================

const {
    Client, GatewayIntentBits, ApplicationCommandOptionType,
    EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ComponentType, ChannelType, PermissionFlagsBits, ModalBuilder,
    TextInputBuilder, TextInputStyle
} = require('discord.js');
const { Pool } = require('pg');
const express = require('express');
const fs = require('fs');
const path = require('path');

// --- Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Court Bot is Live'));
app.get('/health', (req, res) => res.status(200).send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Web server listening on port ${port}`));

// --- Discord & DB ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ]
});

const pool = new Pool({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
const OWNER_ID = process.env.OWNER_ID || 'YOUR_DISCORD_ID_HERE';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { client, pool, OWNER_ID, delay };

// --- Colors ---
const Colors = {
    success: 0x57F287,
    error:   0xED4245,
    warn:    0xFEE75C,
    info:    0x5865F2,
    neutral: 0x2B2D31,
    filed:           0x99AAB5,
    assigned:        0x5865F2,
    waiting_lawyers: 0xFEE75C,
    scheduled:       0xEB459E,
    in_progress:     0xED4245,
    verdict:         0xFF8C00,
    closed:          0x57F287,
    cancelled:       0x2B2D31,
    dismissed:       0x2B2D31,
};

const STATUS_COLORS = {
    FILED:           Colors.filed,
    ASSIGNED:        Colors.assigned,
    WAITING_LAWYERS: Colors.waiting_lawyers,
    SCHEDULED:       Colors.scheduled,
    IN_PROGRESS:     Colors.in_progress,
    VERDICT:         Colors.verdict,
    CLOSED:          Colors.closed,
    CANCELLED:       Colors.cancelled,
    DISMISSED:       Colors.dismissed,
};

const MAX_JURY = 10;

module.exports.Colors = Colors;
module.exports.STATUS_COLORS = STATUS_COLORS;
module.exports.MAX_JURY = MAX_JURY;

// ============================================================
// --- EMBED HELPERS ---
// ============================================================

function simpleEmbed(color, title, description) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}

function infoEmbed(color, title, lines, thumbnail) {
    const e = new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n')).setTimestamp();
    if (thumbnail) e.setThumbnail(thumbnail);
    return e;
}

function errEmbed(msg) { return simpleEmbed(Colors.error, 'Error', msg); }

function ts(date) {
    let t = date ? new Date(date).getTime() : Date.now();
    if (isNaN(t)) t = Date.now();
    return `<t:${Math.floor(t / 1000)}:F>`;
}

module.exports.simpleEmbed = simpleEmbed;
module.exports.infoEmbed = infoEmbed;
module.exports.errEmbed = errEmbed;
module.exports.ts = ts;

// ============================================================
// --- PARSE HELPERS ---
// ============================================================

function parseDuration(str) {
    if (!str) return null;
    if (str.toLowerCase() === 'perm') return -1; // permanent sentinel
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const ms = parseInt(match[1]) * mult[match[2].toLowerCase()];
    if (ms > 365 * 86400000 || ms < 5000) return null;
    return ms;
}

function msToHuman(ms) {
    if (ms === -1) return 'Permanent';
    ms = Number(ms);
    if (ms >= 86400000 && ms % 86400000 === 0) return `${ms / 86400000}d`;
    if (ms >= 3600000  && ms % 3600000  === 0) return `${ms / 3600000}h`;
    if (ms >= 60000    && ms % 60000    === 0) return `${ms / 60000}m`;
    return `${Math.floor(ms / 1000)}s`;
}

function parseIds(str) {
    const matches = str.match(/\d{17,19}/g) || [];
    return [...new Set(matches)];
}

function formatCaseId(num) {
    return `CASE-${String(num).padStart(3, '0')}`;
}

module.exports.parseDuration = parseDuration;
module.exports.msToHuman = msToHuman;
module.exports.parseIds = parseIds;
module.exports.formatCaseId = formatCaseId;

// ============================================================
// --- PAGINATION ---
// ============================================================

function buildPageButtons(page, maxPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(page === maxPages - 1)
    );
}

function buildDisabledButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_page').setLabel('Previous').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_page').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(true)
    );
}

async function paginatedReply(interaction, rows, itemsPerPage, color, title, lineMapper, thumbnail) {
    const maxPages = Math.ceil(rows.length / itemsPerPage);
    let currentPage = 0;

    const generateEmbed = (page) => {
        const start = page * itemsPerPage;
        const lines = rows.slice(start, start + itemsPerPage).map(lineMapper).join('\n\n');
        const e = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${title} (Page ${page + 1} of ${maxPages}) - Total: ${rows.length}`)
            .setDescription(lines || 'Nothing here.')
            .setTimestamp();
        if (thumbnail) e.setThumbnail(thumbnail);
        return e;
    };

    const msg = await interaction.editReply({
        embeds: [generateEmbed(0)],
        components: maxPages > 1 ? [buildPageButtons(0, maxPages)] : []
    });

    if (maxPages === 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 300000 });
    collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) return i.reply({ content: 'Not for you!', ephemeral: true });
        if (i.customId === 'prev_page') currentPage--;
        if (i.customId === 'next_page') currentPage++;
        await i.update({ embeds: [generateEmbed(currentPage)], components: [buildPageButtons(currentPage, maxPages)] });
    });
    collector.on('end', () => {
        interaction.editReply({ components: [buildDisabledButtons()] }).catch(() => {});
    });
}

module.exports.paginatedReply = paginatedReply;

// ============================================================
// --- CONFIRMATION DIALOG ---
// ============================================================

async function confirm(interaction, title, description) {
    const embed = simpleEmbed(Colors.warn, title, description);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    const msg = await interaction.editReply({ embeds: [embed], components: [row] });
    try {
        const btn = await msg.awaitMessageComponent({
            componentType: ComponentType.Button,
            filter: i => i.user.id === interaction.user.id,
            time: 10_000
        });
        await btn.deferUpdate();
        if (btn.customId === 'cancel') {
            await interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, 'Cancelled', 'Action cancelled.')], components: [] });
            setTimeout(() => interaction.deleteReply().catch(() => {}), 2000);
            return false;
        }
        return true;
    } catch {
        await interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, 'Timed Out', 'Confirmation expired.')], components: [] });
        return false;
    }
}

module.exports.confirm = confirm;

// ============================================================
// --- DB INIT ---
// ============================================================

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS action_history (
            id          SERIAL PRIMARY KEY,
            user_id     TEXT NOT NULL,
            action      TEXT NOT NULL,
            reason      TEXT,
            executor_id TEXT,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS guild_config (
            guild_id                TEXT PRIMARY KEY,
            court_category_id       TEXT,
            archive_category_id     TEXT,
            judge_chat_name         TEXT DEFAULT 'judge-chat',
            court_records_name      TEXT DEFAULT 'court-records',
            jury_chat_name          TEXT DEFAULT 'jury-chat',
            case_channel_format     TEXT DEFAULT 'courtcase-{case_id}',
            archive_channel_format  TEXT DEFAULT 'case-{case_id}-archive',
            judge_role_id           TEXT,
            jail_role_id            TEXT,
            slowmode_value          INT DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS cases (
            id                      SERIAL PRIMARY KEY,
            guild_id                TEXT NOT NULL,
            case_number             INT NOT NULL,
            status                  TEXT NOT NULL DEFAULT 'FILED',
            prosecutor_id           TEXT NOT NULL,
            defendant_id            TEXT NOT NULL,
            reason                  TEXT NOT NULL,
            judge_id                TEXT,
            prosecutor_lawyer_id    TEXT,
            defense_lawyer_id       TEXT,
            scheduled_at            TIMESTAMPTZ,
            started_at              TIMESTAMPTZ,
            closed_at               TIMESTAMPTZ,
            verdict                 TEXT,
            verdict_reason          TEXT,
            punishment_type         TEXT,
            punishment_length       TEXT,
            case_channel_id         TEXT,
            jury_chat_channel_id    TEXT,
            judge_chat_channel_id   TEXT,
            pinned_message_id       TEXT,
            evidence_count          INT DEFAULT 0,
            filed_at                TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(guild_id, case_number)
        );

        CREATE TABLE IF NOT EXISTS jury_members (
            id          SERIAL PRIMARY KEY,
            case_id     INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            user_id     TEXT NOT NULL,
            vote        TEXT,
            vote_reason TEXT,
            voted_at    TIMESTAMPTZ,
            UNIQUE(case_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS evidence (
            id            SERIAL PRIMARY KEY,
            case_id       INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            message_id    TEXT NOT NULL,
            author_id     TEXT NOT NULL,
            content       TEXT,
            struck        BOOLEAN DEFAULT FALSE,
            struck_by     TEXT,
            struck_reason TEXT,
            created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS lawyer_requests (
            id              SERIAL PRIMARY KEY,
            case_id         INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            requester_id    TEXT NOT NULL,
            requested_id    TEXT NOT NULL,
            side            TEXT NOT NULL,
            status          TEXT DEFAULT 'PENDING',
            created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS jailed_users (
            id          SERIAL PRIMARY KEY,
            guild_id    TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            jailed_by   TEXT NOT NULL,
            reason      TEXT,
            jailed_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            release_at  TIMESTAMPTZ,
            saved_roles JSONB DEFAULT '[]',
            UNIQUE(guild_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS punishment_timers (
            id          SERIAL PRIMARY KEY,
            guild_id    TEXT NOT NULL,
            user_id     TEXT NOT NULL,
            type        TEXT NOT NULL,
            execute_at  TIMESTAMPTZ NOT NULL,
            case_id     INT,
            created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('Database initialized.');
}

// ============================================================
// --- LOG ACTION ---
// ============================================================

async function logAction(userId, action, reason, executorId) {
    await pool.query(
        'INSERT INTO action_history (user_id, action, reason, executor_id) VALUES ($1, $2, $3, $4)',
        [userId, action, reason || 'No reason provided.', executorId]
    ).catch(() => {});
}

module.exports.logAction = logAction;

// ============================================================
// --- GUILD CONFIG HELPERS ---
// ============================================================

async function getConfig(guildId) {
    const { rows } = await pool.query('SELECT * FROM guild_config WHERE guild_id = $1', [guildId]);
    return rows[0] || null;
}

async function ensureConfig(guildId) {
    await pool.query(
        'INSERT INTO guild_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING',
        [guildId]
    );
    return getConfig(guildId);
}

function resolveChannelName(format, caseNum, defendantId) {
    return format
        .replace('{case_id}', String(caseNum).padStart(3, '0'))
        .replace('{defendant}', defendantId)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .substring(0, 100);
}

module.exports.getConfig = getConfig;
module.exports.ensureConfig = ensureConfig;
module.exports.resolveChannelName = resolveChannelName;

// ============================================================
// --- CASE HELPERS ---
// ============================================================

async function getActiveCases(guildId) {
    const { rows } = await pool.query(
        `SELECT * FROM cases WHERE guild_id = $1 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') ORDER BY filed_at DESC`,
        [guildId]
    );
    return rows;
}

async function getCaseById(caseId) {
    const { rows } = await pool.query('SELECT * FROM cases WHERE id = $1', [caseId]);
    return rows[0] || null;
}

async function getCaseByNumber(guildId, caseNumber) {
    const { rows } = await pool.query('SELECT * FROM cases WHERE guild_id = $1 AND case_number = $2', [guildId, caseNumber]);
    return rows[0] || null;
}

async function getJuryMembers(caseId) {
    const { rows } = await pool.query('SELECT * FROM jury_members WHERE case_id = $1', [caseId]);
    return rows;
}

async function resolveCase(guildId, input) {
    const numMatch = input.match(/(\d+)/);
    if (numMatch) {
        const c = await getCaseByNumber(guildId, parseInt(numMatch[1]));
        if (c) return c;
    }
    const ids = parseIds(input);
    if (ids.length) {
        const { rows } = await pool.query(
            `SELECT * FROM cases WHERE guild_id = $1 AND (prosecutor_id = $2 OR defendant_id = $2) AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') ORDER BY filed_at DESC LIMIT 1`,
            [guildId, ids[0]]
        );
        if (rows[0]) return rows[0];
    }
    return null;
}

module.exports.getActiveCases = getActiveCases;
module.exports.getCaseById = getCaseById;
module.exports.getCaseByNumber = getCaseByNumber;
module.exports.getJuryMembers = getJuryMembers;
module.exports.resolveCase = resolveCase;

// ============================================================
// --- ACTIVE ROLE CONFLICT CHECKS ---
// ============================================================

async function isJudgeOnActiveCase(guildId, userId) {
    const { rows } = await pool.query(
        `SELECT id FROM cases WHERE guild_id = $1 AND judge_id = $2 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') LIMIT 1`,
        [guildId, userId]
    );
    return rows.length > 0;
}

async function isLawyerOnActiveCase(guildId, userId) {
    const { rows } = await pool.query(
        `SELECT id FROM cases WHERE guild_id = $1 AND (prosecutor_lawyer_id = $2 OR defense_lawyer_id = $2) AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') LIMIT 1`,
        [guildId, userId]
    );
    return rows.length > 0;
}

async function isJurorOnActiveCase(guildId, userId) {
    const { rows } = await pool.query(
        `SELECT jm.id FROM jury_members jm JOIN cases c ON c.id = jm.case_id
         WHERE c.guild_id = $1 AND jm.user_id = $2 AND c.status NOT IN ('CLOSED','CANCELLED','DISMISSED') LIMIT 1`,
        [guildId, userId]
    );
    return rows.length > 0;
}

module.exports.isJudgeOnActiveCase = isJudgeOnActiveCase;
module.exports.isLawyerOnActiveCase = isLawyerOnActiveCase;
module.exports.isJurorOnActiveCase = isJurorOnActiveCase;

// ============================================================
// --- PINNED EMBED ---
// ============================================================

async function buildCaseEmbed(c) {
    const jury = await getJuryMembers(c.id);
    const juryList = jury.length ? jury.map(j => `<@${j.user_id}>`).join(', ') : 'No jury yet';
    const statusColor = STATUS_COLORS[c.status] || Colors.neutral;

    const lines = [
        `**Case ID:** ${formatCaseId(c.case_number)}`,
        `**Status:** \`${c.status}\``,
        '',
        `**Prosecutor:** <@${c.prosecutor_id}>`,
        `**Prosecutor's Lawyer:** ${c.prosecutor_lawyer_id ? `<@${c.prosecutor_lawyer_id}>` : '*None assigned*'}`,
        '',
        `**Defendant:** <@${c.defendant_id}>`,
        `**Defense Lawyer:** ${c.defense_lawyer_id ? `<@${c.defense_lawyer_id}>` : '*None assigned*'}`,
        '',
        `**Judge:** ${c.judge_id ? `<@${c.judge_id}>` : '*Not yet assigned*'}`,
        '',
        `**Jury:** ${juryList}`,
        '',
        `**Scheduled:** ${c.scheduled_at ? ts(c.scheduled_at) : '*Not scheduled*'}`,
        `**Evidence Messages:** ${c.evidence_count}`,
    ];

    if (c.verdict) {
        lines.push('');
        lines.push(`**Verdict:** \`${c.verdict}\``);
        lines.push(`**Reason:** ${c.verdict_reason}`);
        if (c.punishment_type) {
            lines.push(`**Punishment:** \`${c.punishment_type}\` - ${c.punishment_length || 'permanent'}`);
        }
    }

    lines.push('');
    lines.push(`**Filed:** ${ts(c.filed_at)}`);
    lines.push(`**Reason:** ${c.reason}`);

    return new EmbedBuilder()
        .setColor(statusColor)
        .setTitle(`Case ${formatCaseId(c.case_number)} - ${c.status}`)
        .setDescription(lines.join('\n'))
        .setTimestamp();
}

async function updatePinnedEmbed(c) {
    if (!c.case_channel_id || !c.pinned_message_id) return;
    try {
        const channel = await client.channels.fetch(c.case_channel_id).catch(() => null);
        if (!channel) return;
        const msg = await channel.messages.fetch(c.pinned_message_id).catch(() => null);
        if (!msg) return;
        await msg.edit({ embeds: [await buildCaseEmbed(c)] });
    } catch (e) {
        console.error('Failed to update pinned embed:', e.message);
    }
}

module.exports.buildCaseEmbed = buildCaseEmbed;
module.exports.updatePinnedEmbed = updatePinnedEmbed;

// ============================================================
// --- DM HELPERS ---
// ============================================================

async function dmUser(userId, embed) {
    try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [embed] });
    } catch { /* DMs may be closed */ }
}

async function dmAll(userIds, embed) {
    for (const id of userIds) await dmUser(id, embed);
}

async function getCaseParticipants(c) {
    const jury = await getJuryMembers(c.id);
    const ids = new Set([c.prosecutor_id, c.defendant_id]);
    if (c.judge_id) ids.add(c.judge_id);
    if (c.prosecutor_lawyer_id) ids.add(c.prosecutor_lawyer_id);
    if (c.defense_lawyer_id) ids.add(c.defense_lawyer_id);
    jury.forEach(j => ids.add(j.user_id));
    return [...ids];
}

module.exports.dmUser = dmUser;
module.exports.dmAll = dmAll;
module.exports.getCaseParticipants = getCaseParticipants;

// ============================================================
// --- CHANNEL PERMISSION HELPERS ---
// ============================================================

async function addParticipantToChannel(channel, userId) {
    await channel.permissionOverwrites.create(userId, {
        ViewChannel: true,
        SendMessages: true,
    }).catch(() => {});
}

async function removeParticipantFromChannel(channel, userId) {
    await channel.permissionOverwrites.delete(userId).catch(() => {});
}

async function lockChannel(channel) {
    await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
        SendMessages: false,
        ViewChannel: true,
    }).catch(() => {});
    for (const [id] of channel.permissionOverwrites.cache) {
        if (id !== channel.guild.roles.everyone.id) {
            await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
        }
    }
}

module.exports.addParticipantToChannel = addParticipantToChannel;
module.exports.removeParticipantFromChannel = removeParticipantFromChannel;
module.exports.lockChannel = lockChannel;

// ============================================================
// --- ARCHIVE HELPER ---
// ============================================================

async function archiveCase(c, guild, config, summaryEmbed) {
    try {
        if (c.case_channel_id) {
            const ch = await guild.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) {
                const archiveName = resolveChannelName(config.archive_channel_format || 'case-{case_id}-archive', c.case_number, c.defendant_id);
                await ch.setName(archiveName).catch(() => {});
                if (config.archive_category_id) {
                    await ch.setParent(config.archive_category_id, { lockPermissions: false }).catch(() => {});
                }
                await lockChannel(ch);
            }
        }
        if (config.court_records_name) {
            const recordsChannel = guild.channels.cache.find(
                ch => ch.name === config.court_records_name && ch.type === ChannelType.GuildText
            );
            if (recordsChannel && summaryEmbed) {
                await recordsChannel.send({ embeds: [summaryEmbed] }).catch(() => {});
            }
        }
        await pool.query('UPDATE cases SET closed_at = NOW() WHERE id = $1', [c.id]);
    } catch (e) {
        console.error('Archive error:', e.message);
    }
}

function buildSummaryEmbed(c, closedBy) {
    const lines = [
        `**Case:** ${formatCaseId(c.case_number)}`,
        `**Status:** \`${c.status}\``,
        `**Prosecutor:** <@${c.prosecutor_id}>`,
        `**Defendant:** <@${c.defendant_id}>`,
        `**Judge:** ${c.judge_id ? `<@${c.judge_id}>` : 'None'}`,
        `**Prosecutor's Lawyer:** ${c.prosecutor_lawyer_id ? `<@${c.prosecutor_lawyer_id}>` : 'None'}`,
        `**Defense Lawyer:** ${c.defense_lawyer_id ? `<@${c.defense_lawyer_id}>` : 'None'}`,
        `**Filed:** ${ts(c.filed_at)}`,
        `**Closed:** ${ts(new Date())}`,
    ];
    if (c.verdict) {
        lines.push(`**Verdict:** \`${c.verdict}\``);
        lines.push(`**Verdict Reason:** ${c.verdict_reason}`);
        if (c.punishment_type) lines.push(`**Punishment:** \`${c.punishment_type}\` - ${c.punishment_length || 'permanent'}`);
    }
    if (closedBy) lines.push(`**Closed by:** ${closedBy}`);
    const color = STATUS_COLORS[c.status] || Colors.neutral;
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`Case Closed - ${formatCaseId(c.case_number)}`)
        .setDescription(lines.join('\n'))
        .setTimestamp();
}

module.exports.archiveCase = archiveCase;
module.exports.buildSummaryEmbed = buildSummaryEmbed;

// ============================================================
// --- PUNISHMENT ENGINE ---
// ============================================================

const activeTimers = new Map();     // caseId or `jail_userId_guildId` -> timeout handle
const activeBanTimers = new Map();  // `ban_userId_guildId` -> timeout handle

async function jailUser(guild, targetMember, jailedById, reason, durationMs, config) {
    if (!config?.jail_role_id) throw new Error('Jail role not configured. Run /setup first.');

    // Save current roles (excluding @everyone and the jail role itself)
    const savedRoles = targetMember.roles.cache
        .filter(r => r.id !== guild.roles.everyone.id && r.id !== config.jail_role_id)
        .map(r => r.id);

    // Remove all roles
    await targetMember.roles.set([config.jail_role_id]).catch(e => { throw new Error(`Failed to set jail role: ${e.message}`); });

    const releaseAt = durationMs === -1 ? null : new Date(Date.now() + durationMs);

    // Upsert jailed_users record
    await pool.query(`
        INSERT INTO jailed_users (guild_id, user_id, jailed_by, reason, release_at, saved_roles)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
            jailed_by = $3, reason = $4, release_at = $5, saved_roles = $6, jailed_at = NOW()
    `, [guild.id, targetMember.id, jailedById, reason || 'No reason provided.', releaseAt, JSON.stringify(savedRoles)]);

    // Schedule auto-release if not permanent
    if (durationMs !== -1 && releaseAt) {
        await scheduleJailRelease(guild.id, targetMember.id, durationMs);
    }
}

async function unjailUser(guild, userId, config) {
    if (!config?.jail_role_id) throw new Error('Jail role not configured.');

    const { rows } = await pool.query(
        'SELECT * FROM jailed_users WHERE guild_id = $1 AND user_id = $2',
        [guild.id, userId]
    );
    if (!rows.length) throw new Error('User is not currently jailed.');

    const record = rows[0];
    const member = await guild.members.fetch(userId).catch(() => null);

    if (member) {
        // Parse saved roles
        let savedRoles = [];
        try {
            savedRoles = typeof record.saved_roles === 'string'
                ? JSON.parse(record.saved_roles)
                : record.saved_roles;
        } catch { savedRoles = []; }

        // Filter to roles that still exist in the guild
        const validRoles = savedRoles.filter(rId => guild.roles.cache.has(rId));

        // Remove jail role and restore saved roles
        await member.roles.set(validRoles).catch(e => console.error('Role restore error:', e.message));
    }

    // Remove from DB
    await pool.query('DELETE FROM jailed_users WHERE guild_id = $1 AND user_id = $2', [guild.id, userId]);

    // Clear any active timer
    const timerKey = `jail_${userId}_${guild.id}`;
    if (activeTimers.has(timerKey)) {
        clearTimeout(activeTimers.get(timerKey));
        activeTimers.delete(timerKey);
    }
}

async function scheduleJailRelease(guildId, userId, ms) {
    const timerKey = `jail_${userId}_${guildId}`;
    if (activeTimers.has(timerKey)) {
        clearTimeout(activeTimers.get(timerKey));
        activeTimers.delete(timerKey);
    }
    const handle = setTimeout(async () => {
        activeTimers.delete(timerKey);
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const config = await getConfig(guildId);
        await unjailUser(guild, userId, config).catch(e => console.error('Auto-unjail error:', e.message));
        await dmUser(userId, simpleEmbed(Colors.success, 'Released from Jail', `You have been automatically released in **${guild.name}**.`));
        await logAction(userId, 'AUTO_UNJAILED', 'Sentence served.', client.user.id);
    }, ms);
    activeTimers.set(timerKey, handle);
}

async function scheduleUnban(guildId, userId, ms) {
    const timerKey = `ban_${userId}_${guildId}`;
    if (activeBanTimers.has(timerKey)) {
        clearTimeout(activeBanTimers.get(timerKey));
        activeBanTimers.delete(timerKey);
    }
    const handle = setTimeout(async () => {
        activeBanTimers.delete(timerKey);
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        await guild.members.unban(userId, 'Temporary ban expired.').catch(() => {});
        await pool.query('DELETE FROM punishment_timers WHERE guild_id = $1 AND user_id = $2 AND type = $3', [guildId, userId, 'UNBAN']);
        await logAction(userId, 'AUTO_UNBANNED', 'Temporary ban expired.', client.user.id);
    }, ms);
    activeBanTimers.set(timerKey, handle);
}

async function applyVerdictPunishment(guild, c, config) {
    if (!c.punishment_type || c.verdict !== 'GUILTY') return;

    const member = await guild.members.fetch(c.defendant_id).catch(() => null);
    const durationMs = c.punishment_length && c.punishment_length !== 'perm'
        ? parseDuration(c.punishment_length)
        : -1;

    const punishEmbed = new EmbedBuilder()
        .setColor(Colors.error)
        .setTitle('Court Verdict Punishment')
        .setDescription(`You have been found **GUILTY** in **${guild.name}** (${formatCaseId(c.case_number)}).\n**Punishment:** \`${c.punishment_type}\`\n**Duration:** ${durationMs === -1 ? 'Permanent' : msToHuman(durationMs)}\n**Reason:** ${c.verdict_reason}`)
        .setTimestamp();

    await dmUser(c.defendant_id, punishEmbed).catch(() => {});

    switch (c.punishment_type) {
        case 'JAIL':
            if (!member) break;
            await jailUser(guild, member, client.user.id, `Court verdict: ${c.verdict_reason}`, durationMs, config);
            break;

        case 'BAN':
            await guild.members.ban(c.defendant_id, { reason: `Court verdict: ${c.verdict_reason}` }).catch(e => console.error('Ban error:', e.message));
            if (durationMs !== -1) {
                await pool.query(
                    `INSERT INTO punishment_timers (guild_id, user_id, type, execute_at, case_id) VALUES ($1, $2, 'UNBAN', $3, $4)`,
                    [guild.id, c.defendant_id, new Date(Date.now() + durationMs), c.id]
                );
                await scheduleUnban(guild.id, c.defendant_id, durationMs);
            }
            break;

        case 'KICK':
            if (!member) break;
            await member.kick(`Court verdict: ${c.verdict_reason}`).catch(e => console.error('Kick error:', e.message));
            break;

        case 'MUTE':
            if (!member) break;
            const muteMs = durationMs === -1 ? 28 * 24 * 60 * 60 * 1000 : durationMs; // Discord max timeout = 28d
            await member.timeout(muteMs, `Court verdict: ${c.verdict_reason}`).catch(e => console.error('Mute error:', e.message));
            break;
    }

    await logAction(c.defendant_id, `PUNISHMENT_${c.punishment_type}`, c.verdict_reason, client.user.id);
}

module.exports.jailUser = jailUser;
module.exports.unjailUser = unjailUser;
module.exports.scheduleJailRelease = scheduleJailRelease;
module.exports.scheduleUnban = scheduleUnban;
module.exports.applyVerdictPunishment = applyVerdictPunishment;
module.exports.activeTimers = activeTimers;
module.exports.activeBanTimers = activeBanTimers;

// ============================================================
// --- SCHEDULED CASE TIMERS ---
// ============================================================

async function scheduleCase(c) {
    if (activeTimers.has(`case_${c.id}`)) {
        clearTimeout(activeTimers.get(`case_${c.id}`));
        activeTimers.delete(`case_${c.id}`);
    }
    if (!c.scheduled_at) return;
    const ms = new Date(c.scheduled_at).getTime() - Date.now();
    if (ms <= 0) {
        await startCaseNow(c.id);
        return;
    }
    const handle = setTimeout(() => startCaseNow(c.id), ms);
    activeTimers.set(`case_${c.id}`, handle);
}

async function startCaseNow(caseId) {
    activeTimers.delete(`case_${caseId}`);
    const c = await getCaseById(caseId);
    if (!c || c.status !== 'SCHEDULED') return;

    await pool.query(`UPDATE cases SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = $1`, [caseId]);
    const updated = await getCaseById(caseId);

    if (updated.case_channel_id) {
        const ch = await client.channels.fetch(updated.case_channel_id).catch(() => null);
        if (ch) {
            await ch.send({ embeds: [simpleEmbed(Colors.in_progress, 'Court is Now in Session', `${formatCaseId(updated.case_number)} has officially begun. All parties, please take your positions.`)] });
        }
    }

    await updatePinnedEmbed(updated);

    const participants = await getCaseParticipants(updated);
    const dmEmbed = simpleEmbed(Colors.in_progress, 'Court is Now in Session', `${formatCaseId(updated.case_number)} has begun.`);
    await dmAll(participants, dmEmbed);

    await logAction(updated.guild_id, 'CASE_STARTED', formatCaseId(updated.case_number), client.user.id);
}

async function rehydrateTimers() {
    // Rehydrate case timers
    const { rows: caseRows } = await pool.query(`SELECT * FROM cases WHERE status = 'SCHEDULED' AND scheduled_at > NOW()`);
    for (const c of caseRows) await scheduleCase(c);

    // Rehydrate jail timers
    const { rows: jailRows } = await pool.query(`SELECT * FROM jailed_users WHERE release_at IS NOT NULL AND release_at > NOW()`);
    for (const j of jailRows) {
        const ms = new Date(j.release_at).getTime() - Date.now();
        await scheduleJailRelease(j.guild_id, j.user_id, ms);
    }

    // Rehydrate ban timers
    const { rows: banRows } = await pool.query(`SELECT * FROM punishment_timers WHERE type = 'UNBAN' AND execute_at > NOW()`);
    for (const b of banRows) {
        const ms = new Date(b.execute_at).getTime() - Date.now();
        await scheduleUnban(b.guild_id, b.user_id, ms);
    }

    console.log(`Re-hydrated ${caseRows.length} case timer(s), ${jailRows.length} jail timer(s), ${banRows.length} ban timer(s).`);
}

module.exports.scheduleCase = scheduleCase;
module.exports.startCaseNow = startCaseNow;
module.exports.rehydrateTimers = rehydrateTimers;

// ============================================================
// --- ASSIGN LAWYER HELPER ---
// ============================================================

async function _assignLawyer(c, req, userId, guild) {
    const field = req.side === 'prosecution' ? 'prosecutor_lawyer_id' : 'defense_lawyer_id';
    await pool.query(`UPDATE cases SET ${field} = $1 WHERE id = $2`, [userId, c.id]);

    const updated = await getCaseById(c.id);

    if (updated.prosecutor_lawyer_id && updated.defense_lawyer_id && updated.judge_id && updated.status === 'WAITING_LAWYERS') {
        await pool.query(`UPDATE cases SET status = 'ASSIGNED' WHERE id = $1`, [updated.id]);
    }

    const final = await getCaseById(c.id);

    if (final.case_channel_id) {
        const ch = await guild.channels.fetch(final.case_channel_id).catch(() => null);
        if (ch) await addParticipantToChannel(ch, userId);
    }

    await updatePinnedEmbed(final);

    const participants = await getCaseParticipants(final);
    await dmAll(participants, simpleEmbed(Colors.success, 'Lawyer Assigned', `<@${userId}> is now the ${req.side} lawyer for **${formatCaseId(final.case_number)}**.`));
}

module.exports._assignLawyer = _assignLawyer;

// ============================================================
// --- SETUP WIZARD ---
// ============================================================

const SETUP_STEPS_1 = [
    { key: 'court_category_id',      label: 'Court Category ID',           hint: 'Category ID where active case channels will be created.' },
    { key: 'archive_category_id',    label: 'Archive Category ID',         hint: 'Category ID where closed case channels will be moved.' },
    { key: 'judge_chat_name',        label: 'Judge Chat Channel Name',     hint: 'Name for the judge-only channel (e.g. judge-chat).' },
    { key: 'court_records_name',     label: 'Court Records Channel Name',  hint: 'Name for the public records channel (e.g. court-records).' },
    { key: 'jury_chat_name',         label: 'Jury Chat Channel Name',      hint: 'Name for the jury channel (e.g. jury-chat).' },
];

const SETUP_STEPS_2 = [
    { key: 'case_channel_format',    label: 'Case Channel Name Format',    hint: 'Supports {case_id} and {defendant} (e.g. courtcase-{case_id}).' },
    { key: 'archive_channel_format', label: 'Archive Channel Name Format', hint: 'Supports {case_id} and {defendant} (e.g. case-{case_id}-archive).' },
    { key: 'judge_role_id',          label: 'Judge Role ID',               hint: 'The Discord role ID for judges.' },
    { key: 'jail_role_id',           label: 'Jail Role ID',                hint: 'The Discord role ID assigned to jailed users.' },
    { key: 'slowmode_value',         label: 'Slowmode Value (seconds)',     hint: 'Slowmode for case channels in seconds (0 = off).' },
];

const setupSessions = new Map(); // userId -> { step, modal, values, guildId }

function buildSetupInitEmbed(config) {
    const lines = [
        'Welcome to the Court Bot setup wizard.',
        '',
        'Click **Start Setup** to configure the bot in two steps.',
        'Click **Close Setup** to cancel.',
        '',
        config ? '**Current configuration exists.** Starting setup will overwrite it.' : 'No configuration found yet.',
    ];
    return new EmbedBuilder()
        .setColor(Colors.info)
        .setTitle('Court Bot Setup')
        .setDescription(lines.join('\n'))
        .setTimestamp();
}

function buildSetupModal(modalNum, values) {
    const steps = modalNum === 1 ? SETUP_STEPS_1 : SETUP_STEPS_2;
    const modal = new ModalBuilder()
        .setCustomId(`setup_modal_${modalNum}`)
        .setTitle(`Setup - Part ${modalNum} of 2`);

    for (const step of steps) {
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(step.key)
                    .setLabel(step.label)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder(step.hint.substring(0, 100))
                    .setValue(values[step.key] || '')
                    .setRequired(false)
            )
        );
    }
    return modal;
}

module.exports.setupSessions = setupSessions;
module.exports.buildSetupInitEmbed = buildSetupInitEmbed;
module.exports.buildSetupModal = buildSetupModal;
module.exports.SETUP_STEPS_1 = SETUP_STEPS_1;
module.exports.SETUP_STEPS_2 = SETUP_STEPS_2;

// ============================================================
// --- READY ---
// ============================================================

// Load commands from part 2
const registerCommands2 = require('./commands.js');

client.once('ready', async () => {
    console.log(`Court Bot online as: ${client.user.tag}`);
    await initDB();
    await rehydrateTimers();

    const CMD_GUILD = { integration_types: [0], contexts: [0] };

    await client.application.commands.set([
        // Setup
        { name: 'setup',        description: 'Interactive court setup wizard (admin only)', ...CMD_GUILD },
        { name: 'courtconfig',  description: 'View current court configuration (admin only)', ...CMD_GUILD },

        // Case Filing
        { name: 'filecase', description: 'File a case against a user', ...CMD_GUILD, options: [
            { name: 'user',   description: 'The defendant',   type: ApplicationCommandOptionType.User,   required: true },
            { name: 'reason', description: 'Reason for case', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'cancelcase', description: 'Cancel your active filed case', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID (e.g. 1 or CASE-001)', type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',  description: 'Reason for cancellation',      type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Judge Commands
        { name: 'claimcase', description: 'Claim a case as judge', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'startcase', description: 'Schedule the case to go live', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',                        type: ApplicationCommandOptionType.String, required: true },
            { name: 'time',    description: 'Time from now (e.g. 1h, 30m)',   type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'postpone', description: 'Reschedule a case', ...CMD_GUILD, options: [
            { name: 'case_id',  description: 'Case ID',                type: ApplicationCommandOptionType.String, required: true },
            { name: 'new_time', description: 'New time (e.g. 2h)',     type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'endcase', description: 'End a case manually', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',  description: 'Reason',  type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'dismiss', description: 'Dismiss a case', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',             type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',  description: 'Reason for dismissal', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'verdict', description: 'Set the final verdict', ...CMD_GUILD, options: [
            { name: 'case_id',          description: 'Case ID',              type: ApplicationCommandOptionType.String, required: true },
            { name: 'verdict',          description: 'guilty or not guilty', type: ApplicationCommandOptionType.String, required: true,
              choices: [{ name: 'Guilty', value: 'GUILTY' }, { name: 'Not Guilty', value: 'NOT GUILTY' }] },
            { name: 'reason',           description: 'Charges or reason',    type: ApplicationCommandOptionType.String, required: true },
            { name: 'punishment_type',  description: 'Punishment to apply',  type: ApplicationCommandOptionType.String, required: false,
              choices: [
                  { name: 'Mute (timeout)',  value: 'MUTE' },
                  { name: 'Ban',             value: 'BAN'  },
                  { name: 'Kick',            value: 'KICK' },
                  { name: 'Jail',            value: 'JAIL' },
              ]},
            { name: 'punishment_length', description: 'Duration (e.g. 1h, 7d, perm)', type: ApplicationCommandOptionType.String, required: false },
        ]},
        { name: 'assignjudge', description: 'Assign the judge role to a user (admin only)', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to assign', type: ApplicationCommandOptionType.User, required: true },
        ]},
        { name: 'revokejudge', description: 'Remove the judge role from a user (admin only)', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to revoke', type: ApplicationCommandOptionType.User, required: true },
        ]},
        { name: 'transfercase', description: 'Transfer a case to a new judge (admin only)', ...CMD_GUILD, options: [
            { name: 'case_id',   description: 'Case ID',       type: ApplicationCommandOptionType.String, required: true },
            { name: 'new_judge', description: 'New judge user', type: ApplicationCommandOptionType.User,   required: true },
        ]},
        { name: 'forcestart', description: 'Force start a case (admin override)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'setstatus', description: 'Manually set a case status (admin only)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
            { name: 'status',  description: 'Status',  type: ApplicationCommandOptionType.String, required: true,
              choices: [
                  { name: 'FILED',           value: 'FILED'           },
                  { name: 'ASSIGNED',        value: 'ASSIGNED'        },
                  { name: 'WAITING_LAWYERS', value: 'WAITING_LAWYERS' },
                  { name: 'SCHEDULED',       value: 'SCHEDULED'       },
                  { name: 'IN_PROGRESS',     value: 'IN_PROGRESS'     },
                  { name: 'VERDICT',         value: 'VERDICT'         },
                  { name: 'CLOSED',          value: 'CLOSED'          },
                  { name: 'DISMISSED',       value: 'DISMISSED'       },
              ]},
        ]},
        { name: 'editcase', description: 'Edit case fields directly (admin only)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',    type: ApplicationCommandOptionType.String, required: true },
            { name: 'field',   description: 'Field name', type: ApplicationCommandOptionType.String, required: true,
              choices: [
                  { name: 'reason',          value: 'reason'          },
                  { name: 'verdict_reason',  value: 'verdict_reason'  },
                  { name: 'punishment_type', value: 'punishment_type' },
                  { name: 'punishment_length', value: 'punishment_length' },
              ]},
            { name: 'value', description: 'New value', type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Lawyer Commands
        { name: 'requestlawyer', description: 'Request a user to be your lawyer', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',        type: ApplicationCommandOptionType.String, required: true },
            { name: 'user',    description: 'User to request', type: ApplicationCommandOptionType.User,   required: true },
        ]},
        { name: 'revokelawyer', description: 'Fire your current lawyer', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',  description: 'Reason',  type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'acceptlawyer', description: 'Accept a lawyer request', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID (e.g. 1 or CASE-001)', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'declinelawyer', description: 'Decline a lawyer request', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID (e.g. 1 or CASE-001)', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'replacelawyer', description: 'Force swap a lawyer on a case (admin only)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',           type: ApplicationCommandOptionType.String, required: true },
            { name: 'side',    description: 'prosecution/defense', type: ApplicationCommandOptionType.String, required: true,
              choices: [{ name: 'Prosecution', value: 'prosecution' }, { name: 'Defense', value: 'defense' }] },
            { name: 'user',    description: 'New lawyer',          type: ApplicationCommandOptionType.User,   required: true },
        ]},

        // Jury Commands
        { name: 'joinjury', description: 'Volunteer to join the jury', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'kickjuror', description: 'Remove a juror from a case (judge only)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
            { name: 'user',    description: 'Juror',   type: ApplicationCommandOptionType.User,   required: true },
            { name: 'reason',  description: 'Reason',  type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'vote', description: 'Cast your jury vote', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID',      type: ApplicationCommandOptionType.String, required: true },
            { name: 'vote',    description: 'Your vote',    type: ApplicationCommandOptionType.String, required: true,
              choices: [{ name: 'Guilty', value: 'GUILTY' }, { name: 'Not Guilty', value: 'NOT GUILTY' }] },
            { name: 'reason',  description: 'Your reasoning', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'jurytally', description: 'View the current jury vote tally (judge only)', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Evidence
        { name: 'strikeevidence', description: 'Strike a message from the evidence log', ...CMD_GUILD, options: [
            { name: 'case_id',    description: 'Case ID',           type: ApplicationCommandOptionType.String, required: true },
            { name: 'message_id', description: 'The message ID',    type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',     description: 'Reason',            type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'evidence', description: 'View paginated evidence log for a case', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'exportcase', description: 'DM yourself a transcript of the case', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Info
        { name: 'caseinfo',    description: 'View full case details', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID or user mention', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'listcases',   description: 'View all active cases', ...CMD_GUILD },
        { name: 'casehistory', description: 'View a user case history', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to look up', type: ApplicationCommandOptionType.User, required: true },
        ]},
        { name: 'casecount', description: 'View server case statistics', ...CMD_GUILD },

        // Punishment
        { name: 'jail', description: 'Jail a user (admin only)', ...CMD_GUILD, options: [
            { name: 'user',   description: 'User to jail',              type: ApplicationCommandOptionType.User,   required: true },
            { name: 'time',   description: 'Duration (e.g. 1h, perm)',  type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason', description: 'Reason',                    type: ApplicationCommandOptionType.String, required: false },
        ]},
        { name: 'unjail', description: 'Release a jailed user (admin only)', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to release', type: ApplicationCommandOptionType.User, required: true },
        ]},
    ]);

    console.log('Commands registered.');
});

// ============================================================
// --- INTERACTION HANDLER ---
// ============================================================

client.on('interactionCreate', async interaction => {
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.user.id === OWNER_ID;

    // ---- SLASH COMMANDS ----
    if (interaction.isChatInputCommand()) {
        await interaction.deferReply({ ephemeral: false });
        const cmd = interaction.commandName;
        const guildId = interaction.guildId;

        try {

            // ================================================================
            // /setup
            // ================================================================
            if (cmd === 'setup') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await ensureConfig(guildId);
                const values = {
                    court_category_id:      config.court_category_id      || '',
                    archive_category_id:    config.archive_category_id    || '',
                    judge_chat_name:        config.judge_chat_name         || 'judge-chat',
                    court_records_name:     config.court_records_name      || 'court-records',
                    jury_chat_name:         config.jury_chat_name          || 'jury-chat',
                    case_channel_format:    config.case_channel_format     || 'courtcase-{case_id}',
                    archive_channel_format: config.archive_channel_format  || 'case-{case_id}-archive',
                    judge_role_id:          config.judge_role_id           || '',
                    jail_role_id:           config.jail_role_id            || '',
                    slowmode_value:         String(config.slowmode_value   || '0'),
                };
                setupSessions.set(interaction.user.id, { values, guildId });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('setup_start').setLabel('Start Setup').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('setup_close').setLabel('Close Setup').setStyle(ButtonStyle.Secondary),
                );
                await interaction.editReply({ embeds: [buildSetupInitEmbed(config)], components: [row] });
                return;
            }

            // ================================================================
            // /courtconfig
            // ================================================================
            if (cmd === 'courtconfig') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config) return interaction.editReply({ embeds: [errEmbed('No configuration found. Run /setup first.')] });
                const lines = [
                    `**Court Category:** ${config.court_category_id ? `<#${config.court_category_id}>` : '*Not set*'}`,
                    `**Archive Category:** ${config.archive_category_id ? `<#${config.archive_category_id}>` : '*Not set*'}`,
                    `**Judge Chat Name:** \`${config.judge_chat_name || 'Not set'}\``,
                    `**Court Records Name:** \`${config.court_records_name || 'Not set'}\``,
                    `**Jury Chat Name:** \`${config.jury_chat_name || 'Not set'}\``,
                    `**Case Channel Format:** \`${config.case_channel_format || 'Not set'}\``,
                    `**Archive Channel Format:** \`${config.archive_channel_format || 'Not set'}\``,
                    `**Judge Role:** ${config.judge_role_id ? `<@&${config.judge_role_id}>` : '*Not set*'}`,
                    `**Jail Role:** ${config.jail_role_id ? `<@&${config.jail_role_id}>` : '*Not set*'}`,
                    `**Slowmode:** \`${config.slowmode_value || 0}s\``,
                ];
                return interaction.editReply({ embeds: [infoEmbed(Colors.info, 'Court Configuration', lines)] });
            }

            // ================================================================
            // /filecase
            // ================================================================
            if (cmd === 'filecase') {
                const config = await getConfig(guildId);
                if (!config?.court_category_id) return interaction.editReply({ embeds: [errEmbed('Court not configured. Run /setup first.')] });

                const defendant = interaction.options.getUser('user');
                const reason = interaction.options.getString('reason');

                if (defendant.id === interaction.user.id)
                    return interaction.editReply({ embeds: [errEmbed('You cannot file a case against yourself.')] });
                if (defendant.bot)
                    return interaction.editReply({ embeds: [errEmbed('You cannot file a case against a bot.')] });

                // Check for existing active case between same parties
                const { rows: existingCheck } = await pool.query(
                    `SELECT * FROM cases WHERE guild_id = $1 AND prosecutor_id = $2 AND defendant_id = $3 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED')`,
                    [guildId, interaction.user.id, defendant.id]
                );
                if (existingCheck.length) return interaction.editReply({ embeds: [errEmbed(`You already have an active case against <@${defendant.id}>: **${formatCaseId(existingCheck[0].case_number)}**.`)] });

                const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM cases WHERE guild_id = $1', [guildId]);
                const caseNumber = parseInt(countRows[0].count) + 1;

                const { rows: insertRows } = await pool.query(
                    `INSERT INTO cases (guild_id, case_number, prosecutor_id, defendant_id, reason, status)
                     VALUES ($1, $2, $3, $4, $5, 'FILED') RETURNING *`,
                    [guildId, caseNumber, interaction.user.id, defendant.id, reason]
                );
                const c = insertRows[0];

                const guild = interaction.guild;
                const channelName = resolveChannelName(config.case_channel_format, caseNumber, defendant.id);

                const perms = [
                    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    { id: defendant.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                ];

                const caseChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: config.court_category_id,
                    permissionOverwrites: perms,
                    topic: `Case ${formatCaseId(caseNumber)} | ${interaction.user.tag} vs ${defendant.tag}`,
                    rateLimitPerUser: config.slowmode_value || 0,
                });

                const juryChat = await guild.channels.create({
                    name: config.jury_chat_name || 'jury-chat',
                    type: ChannelType.GuildText,
                    parent: config.court_category_id,
                    permissionOverwrites: [
                        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    ],
                    topic: `Jury discussion for ${formatCaseId(caseNumber)}`,
                });

                const judgeChat = await guild.channels.create({
                    name: config.judge_chat_name || 'judge-chat',
                    type: ChannelType.GuildText,
                    parent: config.court_category_id,
                    permissionOverwrites: [
                        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    ],
                    topic: `Judge channel for ${formatCaseId(caseNumber)}`,
                });

                await pool.query(
                    `UPDATE cases SET case_channel_id = $1, jury_chat_channel_id = $2, judge_chat_channel_id = $3 WHERE id = $4`,
                    [caseChannel.id, juryChat.id, judgeChat.id, c.id]
                );

                const fullCase = await getCaseById(c.id);
                const pinnedMsg = await caseChannel.send({ embeds: [await buildCaseEmbed(fullCase)] });
                await pinnedMsg.pin();
                await pool.query('UPDATE cases SET pinned_message_id = $1 WHERE id = $2', [pinnedMsg.id, c.id]);

                const recordsChannel = guild.channels.cache.find(ch => ch.name === config.court_records_name && ch.type === ChannelType.GuildText);
                if (recordsChannel) {
                    await recordsChannel.send({ embeds: [simpleEmbed(Colors.filed, `New Case Filed - ${formatCaseId(caseNumber)}`, `**Prosecutor:** <@${interaction.user.id}>\n**Defendant:** <@${defendant.id}>\n**Reason:** ${reason}\n\nCase channel: ${caseChannel}`)] });
                }

                await dmUser(defendant.id, simpleEmbed(Colors.warn, 'You Have Been Sued', `<@${interaction.user.id}> has filed a case against you in **${guild.name}**.\n\n**Reason:** ${reason}\n**Case:** ${formatCaseId(caseNumber)}\n\nCase channel: ${caseChannel}`));

                await logAction(defendant.id, 'CASE_FILED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Filed', `**${formatCaseId(caseNumber)}** has been filed.\nCase channel: ${caseChannel}`)] });
            }

            // ================================================================
            // /cancelcase
            // ================================================================
            if (cmd === 'cancelcase') {
                const caseInput = interaction.options.getString('case_id');
                const reason = interaction.options.getString('reason');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.prosecutor_id !== interaction.user.id && !isAdmin)
                    return interaction.editReply({ embeds: [errEmbed('Only the prosecutor or an admin can cancel this case.')] });
                if (['CLOSED','CANCELLED','DISMISSED'].includes(c.status))
                    return interaction.editReply({ embeds: [errEmbed('This case is already closed.')] });

                const ok = await confirm(interaction, 'Cancel Case', `Are you sure you want to cancel **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'CANCELLED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const config = await getConfig(guildId);
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}>`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.warn, 'Case Cancelled', `**${formatCaseId(c.case_number)}** has been cancelled.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_CANCELLED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Cancelled', `**${formatCaseId(c.case_number)}** has been cancelled.`)] });
            }

            // ================================================================
            // /claimcase
            // ================================================================
            if (cmd === 'claimcase') {
                const config = await getConfig(guildId);
                if (!config?.judge_role_id) return interaction.editReply({ embeds: [errEmbed('Judge role not configured.')] });

                const member = interaction.member;
                if (!member.roles.cache.has(config.judge_role_id))
                    return interaction.editReply({ embeds: [errEmbed('You must have the Judge role to claim a case.')] });

                const caseInput = interaction.options.getString('case_id');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.status !== 'FILED') return interaction.editReply({ embeds: [errEmbed(`Case must be in FILED status (current: ${c.status}).`)] });

                if (await isJudgeOnActiveCase(guildId, interaction.user.id))
                    return interaction.editReply({ embeds: [errEmbed('You are already the judge on another active case.')] });

                const newStatus = (!c.prosecutor_lawyer_id || !c.defense_lawyer_id) ? 'WAITING_LAWYERS' : 'ASSIGNED';
                await pool.query(`UPDATE cases SET judge_id = $1, status = $2 WHERE id = $3`, [interaction.user.id, newStatus, c.id]);
                const updated = await getCaseById(c.id);

                const guild = interaction.guild;
                if (updated.case_channel_id) {
                    const ch = await guild.channels.fetch(updated.case_channel_id).catch(() => null);
                    if (ch) await addParticipantToChannel(ch, interaction.user.id);
                }
                if (updated.judge_chat_channel_id) {
                    const jch = await guild.channels.fetch(updated.judge_chat_channel_id).catch(() => null);
                    if (jch) await addParticipantToChannel(jch, interaction.user.id);
                }
                if (updated.jury_chat_channel_id) {
                    const jrch = await guild.channels.fetch(updated.jury_chat_channel_id).catch(() => null);
                    if (jrch) await addParticipantToChannel(jrch, interaction.user.id);
                }

                await updatePinnedEmbed(updated);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.assigned, 'Judge Assigned', `<@${interaction.user.id}> has claimed **${formatCaseId(c.case_number)}** as the presiding judge.`));

                await logAction(interaction.user.id, 'JUDGE_CLAIMED', formatCaseId(c.case_number), interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Claimed', `You are now the judge for **${formatCaseId(c.case_number)}**.`)] });
            }

            // ================================================================
            // /startcase
            // ================================================================
            if (cmd === 'startcase') {
                const caseInput = interaction.options.getString('case_id');
                const timeStr = interaction.options.getString('time');
                const ms = parseDuration(timeStr);
                if (!ms || ms === -1) return interaction.editReply({ embeds: [errEmbed('Invalid time format. Use e.g. 1h, 30m, 2h.')] });

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });
                if (c.status !== 'ASSIGNED' && c.status !== 'WAITING_LAWYERS') return interaction.editReply({ embeds: [errEmbed(`Case must be ASSIGNED or WAITING_LAWYERS to schedule (current: ${c.status}).`)] });
                if (!c.prosecutor_lawyer_id || !c.defense_lawyer_id) return interaction.editReply({ embeds: [errEmbed('Both sides must have a lawyer before the case can be scheduled.')] });

                const scheduledAt = new Date(Date.now() + ms);
                await pool.query(`UPDATE cases SET status = 'SCHEDULED', scheduled_at = $1 WHERE id = $2`, [scheduledAt, c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);
                await scheduleCase(updated);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.scheduled, 'Case Scheduled', `**${formatCaseId(c.case_number)}** is scheduled to begin ${ts(scheduledAt)}.`));

                await logAction(interaction.user.id, 'CASE_SCHEDULED', `${formatCaseId(c.case_number)} at ${scheduledAt.toISOString()}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Scheduled', `**${formatCaseId(c.case_number)}** will go live ${ts(scheduledAt)}.`)] });
            }

            // ================================================================
            // /postpone
            // ================================================================
            if (cmd === 'postpone') {
                const caseInput = interaction.options.getString('case_id');
                const newTimeStr = interaction.options.getString('new_time');
                const ms = parseDuration(newTimeStr);
                if (!ms || ms === -1) return interaction.editReply({ embeds: [errEmbed('Invalid time format.')] });

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });
                if (c.status !== 'SCHEDULED') return interaction.editReply({ embeds: [errEmbed('Case is not scheduled.')] });

                const newTime = new Date(Date.now() + ms);
                await pool.query(`UPDATE cases SET scheduled_at = $1 WHERE id = $2`, [newTime, c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);
                await scheduleCase(updated);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.warn, 'Case Postponed', `**${formatCaseId(c.case_number)}** has been rescheduled to ${ts(newTime)}.`));

                await logAction(interaction.user.id, 'CASE_POSTPONED', `${formatCaseId(c.case_number)} to ${newTime.toISOString()}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Postponed', `**${formatCaseId(c.case_number)}** rescheduled to ${ts(newTime)}.`)] });
            }

            // ================================================================
            // /endcase
            // ================================================================
            if (cmd === 'endcase') {
                const config = await getConfig(guildId);
                const caseInput = interaction.options.getString('case_id');
                const reason = interaction.options.getString('reason');

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.judge_id !== interaction.user.id && !isAdmin)
                    return interaction.editReply({ embeds: [errEmbed('Only the presiding judge or an admin can end this case.')] });

                const ok = await confirm(interaction, 'End Case', `Are you sure you want to end **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'CLOSED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}>`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.neutral, 'Case Ended', `**${formatCaseId(c.case_number)}** has been closed by <@${interaction.user.id}>.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_ENDED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Ended', `**${formatCaseId(c.case_number)}** has been closed.`)] });
            }

            // ================================================================
            // /dismiss
            // ================================================================
            if (cmd === 'dismiss') {
                const config = await getConfig(guildId);
                const caseInput = interaction.options.getString('case_id');
                const reason = interaction.options.getString('reason');

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });

                const ok = await confirm(interaction, 'Dismiss Case', `Are you sure you want to dismiss **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'DISMISSED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}> (dismissed)`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.neutral, 'Case Dismissed', `**${formatCaseId(c.case_number)}** has been dismissed by the judge.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_DISMISSED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Dismissed', `**${formatCaseId(c.case_number)}** has been dismissed.`)] });
            }

            // ================================================================
            // /verdict
            // ================================================================
            if (cmd === 'verdict') {
                const config = await getConfig(guildId);
                const caseInput       = interaction.options.getString('case_id');
                const verdictValue    = interaction.options.getString('verdict');
                const reason          = interaction.options.getString('reason');
                const punishmentType  = interaction.options.getString('punishment_type');
                const punishmentLength = interaction.options.getString('punishment_length');

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });
                if (c.status !== 'IN_PROGRESS') return interaction.editReply({ embeds: [errEmbed('Case must be IN_PROGRESS to set a verdict.')] });

                // Validate punishment length if provided
                if (punishmentType && punishmentLength) {
                    const pMs = parseDuration(punishmentLength);
                    if (pMs === null) return interaction.editReply({ embeds: [errEmbed('Invalid punishment duration. Use e.g. 1h, 7d, or perm.')] });
                }

                await pool.query(
                    `UPDATE cases SET status = 'VERDICT', verdict = $1, verdict_reason = $2, punishment_type = $3, punishment_length = $4 WHERE id = $5`,
                    [verdictValue, reason, punishmentType || null, punishmentLength || null, c.id]
                );
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                if (updated.case_channel_id) {
                    const ch = await guild.channels.fetch(updated.case_channel_id).catch(() => null);
                    if (ch) {
                        const pLine = punishmentType ? `\n**Punishment:** \`${punishmentType}\` - ${punishmentLength || 'permanent'}` : '';
                        await ch.send({ embeds: [new EmbedBuilder()
                            .setColor(verdictValue === 'GUILTY' ? Colors.error : Colors.success)
                            .setTitle(`Verdict - ${formatCaseId(c.case_number)}`)
                            .setDescription(`**Verdict:** \`${verdictValue}\`\n**Reason:** ${reason}${pLine}\n**Judge:** <@${interaction.user.id}>`)
                            .setTimestamp()
                        ] });
                    }
                }

                // Apply punishment if guilty
                if (verdictValue === 'GUILTY' && punishmentType) {
                    await applyVerdictPunishment(guild, updated, config);
                }

                // Archive
                await pool.query(`UPDATE cases SET status = 'CLOSED' WHERE id = $1`, [c.id]);
                const closed = await getCaseById(c.id);
                const summary = buildSummaryEmbed(closed, `Verdict by <@${interaction.user.id}>`);
                await archiveCase(closed, guild, config, summary);
                await updatePinnedEmbed(closed);

                const participants = await getCaseParticipants(updated);
                const pLine = punishmentType ? `\n**Punishment:** \`${punishmentType}\` - ${punishmentLength || 'permanent'}` : '';
                await dmAll(participants, new EmbedBuilder()
                    .setColor(verdictValue === 'GUILTY' ? Colors.error : Colors.success)
                    .setTitle(`Verdict Set - ${formatCaseId(c.case_number)}`)
                    .setDescription(`**Verdict:** \`${verdictValue}\`\n**Reason:** ${reason}${pLine}`)
                    .setTimestamp()
                );

                await logAction(c.defendant_id, `VERDICT_${verdictValue}`, reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Verdict Set', `**${formatCaseId(c.case_number)}** - \`${verdictValue}\`. Case archived.`)] });
            }

            // ================================================================
            // /assignjudge
            // ================================================================
            if (cmd === 'assignjudge') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config?.judge_role_id) return interaction.editReply({ embeds: [errEmbed('Judge role not configured. Run /setup first.')] });
                const user = interaction.options.getUser('user');
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                if (!member) return interaction.editReply({ embeds: [errEmbed('Member not found.')] });
                await member.roles.add(config.judge_role_id);
                await logAction(user.id, 'JUDGE_ASSIGNED', null, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Judge Role Assigned', `<@${user.id}> is now a judge.`)] });
            }

            // ================================================================
            // /revokejudge
            // ================================================================
            if (cmd === 'revokejudge') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config?.judge_role_id) return interaction.editReply({ embeds: [errEmbed('Judge role not configured.')] });
                const user = interaction.options.getUser('user');
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                if (!member) return interaction.editReply({ embeds: [errEmbed('Member not found.')] });
                await member.roles.remove(config.judge_role_id);
                await logAction(user.id, 'JUDGE_REVOKED', null, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Judge Role Revoked', `<@${user.id}> is no longer a judge.`)] });
            }

            // ================================================================
            // /jail
            // ================================================================
            if (cmd === 'jail') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config?.jail_role_id) return interaction.editReply({ embeds: [errEmbed('Jail role not configured. Run /setup first.')] });

                const targetUser = interaction.options.getUser('user');
                const timeStr = interaction.options.getString('time');
                const reason = interaction.options.getString('reason') || 'No reason provided.';

                const durationMs = parseDuration(timeStr);
                if (durationMs === null) return interaction.editReply({ embeds: [errEmbed('Invalid duration. Use e.g. 1h, 30m, 7d, or perm.')] });

                const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
                if (!member) return interaction.editReply({ embeds: [errEmbed('Member not found.')] });

                // Check not already jailed
                const { rows: jailCheck } = await pool.query(
                    'SELECT id FROM jailed_users WHERE guild_id = $1 AND user_id = $2',
                    [guildId, targetUser.id]
                );
                if (jailCheck.length) return interaction.editReply({ embeds: [errEmbed(`<@${targetUser.id}> is already jailed.`)] });

                await jailUser(interaction.guild, member, interaction.user.id, reason, durationMs, config);

                const durationStr = durationMs === -1 ? 'Permanent' : msToHuman(durationMs);
                await dmUser(targetUser.id, simpleEmbed(Colors.error, 'You Have Been Jailed', `You were jailed in **${interaction.guild.name}**.\n**Reason:** ${reason}\n**Duration:** ${durationStr}`));

                await logAction(targetUser.id, 'JAILED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'User Jailed', `<@${targetUser.id}> has been jailed.\n**Duration:** ${durationStr}\n**Reason:** ${reason}`)] });
            }

            // ================================================================
            // /unjail
            // ================================================================
            if (cmd === 'unjail') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                const targetUser = interaction.options.getUser('user');

                await unjailUser(interaction.guild, targetUser.id, config);

                await dmUser(targetUser.id, simpleEmbed(Colors.success, 'Released from Jail', `You have been released in **${interaction.guild.name}**.`));

                await logAction(targetUser.id, 'UNJAILED', 'Manual release by admin.', interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'User Released', `<@${targetUser.id}> has been released from jail.`)] });
            }

            // ================================================================
            // /transfercase /forcestart /setstatus /editcase are in commands.js
            // ================================================================
            const handled = await registerCommands2(interaction, cmd, guildId, isAdmin);
            if (!handled) return interaction.editReply({ embeds: [errEmbed('Unknown command.')] });

        } catch (error) {
            console.error('Command error:', error);
            return interaction.editReply({ embeds: [errEmbed(`An unexpected error occurred.\n\`${error.message}\``)] });
        }
    }

    // ---- BUTTON INTERACTIONS ----
    if (interaction.isButton()) {
        const id = interaction.customId;

        // Setup wizard init buttons
        if (id === 'setup_start' || id === 'setup_close') {
            const session = setupSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: 'Session expired. Run /setup again.', ephemeral: true });

            if (id === 'setup_close') {
                setupSessions.delete(interaction.user.id);
                await interaction.update({ embeds: [simpleEmbed(Colors.neutral, 'Setup Closed', 'Setup wizard closed.')], components: [] });
                return;
            }

            if (id === 'setup_start') {
                const modal = buildSetupModal(1, session.values);
                await interaction.showModal(modal);
                return;
            }
        }

        // Lawyer accept/decline buttons (sent via DM)
        if (id.startsWith('accept_lawyer_') || id.startsWith('decline_lawyer_')) {
            const parts = id.split('_');
            const action = parts[0];
            const caseDbId = parseInt(parts[2]);
            const side = parts[3];

            const c = await getCaseById(caseDbId);
            if (!c) return interaction.reply({ content: 'Case not found or already closed.', ephemeral: true });

            const { rows: reqRows } = await pool.query(
                `SELECT * FROM lawyer_requests WHERE case_id = $1 AND requested_id = $2 AND side = $3 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
                [c.id, interaction.user.id, side]
            );

            if (!reqRows.length) return interaction.update({ content: 'This request is no longer valid.', components: [], embeds: [] });
            const req = reqRows[0];

            if (action === 'accept') {
                const guild = client.guilds.cache.get(c.guild_id);
                if (!guild) return interaction.update({ content: 'Could not find the server.', components: [], embeds: [] });
                await _assignLawyer(c, req, interaction.user.id, guild);
                await pool.query(`UPDATE lawyer_requests SET status = 'ACCEPTED' WHERE id = $1`, [req.id]);
                await interaction.update({ embeds: [simpleEmbed(Colors.success, 'Accepted', `You are now the ${side} lawyer for **${formatCaseId(c.case_number)}**.`)], components: [] });
            } else {
                await pool.query(`UPDATE lawyer_requests SET status = 'DECLINED' WHERE id = $1`, [req.id]);
                await dmUser(req.requester_id, simpleEmbed(Colors.warn, 'Lawyer Request Declined', `<@${interaction.user.id}> declined your lawyer request for **${formatCaseId(c.case_number)}** (${side}).`));
                const guild = client.guilds.cache.get(c.guild_id);
                if (guild && c.case_channel_id) {
                    const ch = await guild.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, 'Lawyer Request Declined', `<@${interaction.user.id}> has declined the lawyer request for the ${side}.`)] });
                }
                await interaction.update({ embeds: [simpleEmbed(Colors.neutral, 'Declined', `You declined the lawyer request for **${formatCaseId(c.case_number)}**.`)], components: [] });
            }
            return;
        }
    }

    // ---- MODAL SUBMISSIONS ----
    if (interaction.isModalSubmit()) {
        const id = interaction.customId;

        if (id === 'setup_modal_1') {
            const session = setupSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: 'Session expired. Run /setup again.', ephemeral: true });

            for (const step of SETUP_STEPS_1) {
                const val = interaction.fields.getTextInputValue(step.key).trim();
                if (val) session.values[step.key] = val;
            }

            setupSessions.set(interaction.user.id, session);

            // Show modal 2
            const modal2 = buildSetupModal(2, session.values);
            await interaction.showModal(modal2);
            return;
        }

        if (id === 'setup_modal_2') {
            const session = setupSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: 'Session expired. Run /setup again.', ephemeral: true });

            for (const step of SETUP_STEPS_2) {
                const val = interaction.fields.getTextInputValue(step.key).trim();
                if (val) session.values[step.key] = val;
            }

            const v = session.values;

            await pool.query(`
                INSERT INTO guild_config (guild_id, court_category_id, archive_category_id, judge_chat_name, court_records_name, jury_chat_name, case_channel_format, archive_channel_format, judge_role_id, jail_role_id, slowmode_value)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT (guild_id) DO UPDATE SET
                    court_category_id = $2, archive_category_id = $3, judge_chat_name = $4,
                    court_records_name = $5, jury_chat_name = $6, case_channel_format = $7,
                    archive_channel_format = $8, judge_role_id = $9, jail_role_id = $10, slowmode_value = $11
            `, [
                session.guildId,
                v.court_category_id || null,
                v.archive_category_id || null,
                v.judge_chat_name || 'judge-chat',
                v.court_records_name || 'court-records',
                v.jury_chat_name || 'jury-chat',
                v.case_channel_format || 'courtcase-{case_id}',
                v.archive_channel_format || 'case-{case_id}-archive',
                v.judge_role_id || null,
                v.jail_role_id || null,
                parseInt(v.slowmode_value) || 0,
            ]);

            setupSessions.delete(interaction.user.id);
            await interaction.reply({ embeds: [simpleEmbed(Colors.success, 'Setup Complete', 'Court bot is fully configured and ready!')], ephemeral: true });
            return;
        }
    }
});

// ============================================================
// --- ROLE RESTORATION GUARD ---
// Detects if a jailed user's jail role is manually removed
// and immediately re-applies it unless the bot is releasing them.
// ============================================================

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const guildId = newMember.guild.id;
    const userId = newMember.id;

    // Check if this user is in the jailed_users DB
    const { rows } = await pool.query(
        'SELECT * FROM jailed_users WHERE guild_id = $1 AND user_id = $2',
        [guildId, userId]
    ).catch(() => ({ rows: [] }));

    if (!rows.length) return; // Not jailed, nothing to do

    const config = await getConfig(guildId).catch(() => null);
    if (!config?.jail_role_id) return;

    const hadJailRole = oldMember.roles.cache.has(config.jail_role_id);
    const hasJailRole = newMember.roles.cache.has(config.jail_role_id);

    // If jail role was removed but the bot didn't initiate it (record still exists)
    if (hadJailRole && !hasJailRole) {
        // Re-apply jail role immediately
        await newMember.roles.add(config.jail_role_id, 'Jail role re-applied: user still jailed.').catch(e => {
            console.error(`Failed to re-apply jail role for ${userId}:`, e.message);
        });
    }
});

// ============================================================
// --- MESSAGE HANDLER (Evidence Logging) ---
// ============================================================

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const { rows } = await pool.query(
        `SELECT * FROM cases WHERE guild_id = $1 AND case_channel_id = $2 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED')`,
        [message.guild.id, message.channel.id]
    );
    const c = rows[0];
    if (!c) return;

    const participantIds = [
        c.prosecutor_id, c.defendant_id,
        c.judge_id, c.prosecutor_lawyer_id, c.defense_lawyer_id
    ].filter(Boolean);

    const jury = await getJuryMembers(c.id);
    jury.forEach(j => participantIds.push(j.user_id));

    if (!participantIds.includes(message.author.id)) return;

    const content = message.content || (message.attachments.size ? `[${message.attachments.size} attachment(s)]` : '[no content]');
    await pool.query(
        `INSERT INTO evidence (case_id, message_id, author_id, content) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [c.id, message.id, message.author.id, content.substring(0, 2000)]
    );
    await pool.query(`UPDATE cases SET evidence_count = evidence_count + 1 WHERE id = $1`, [c.id]);

    const updated = await getCaseById(c.id);
    await updatePinnedEmbed(updated);
});

// ============================================================
// --- LOGIN ---
// ============================================================

client.login(process.env.BOT_TOKEN);
