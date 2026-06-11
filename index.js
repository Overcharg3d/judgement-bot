'use strict';

const {
    Client, GatewayIntentBits, ApplicationCommandOptionType,
    EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
    ComponentType, ChannelType, PermissionFlagsBits, ModalBuilder,
    TextInputBuilder, TextInputStyle
} = require('discord.js');
const { Pool } = require('pg');
const express = require('express');

// --- Web Server ---
const app = express();
app.get('/', (req, res) => res.send('Court Bot is Live ⚖️'));
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

// --- Colors ---
const Colors = {
    success: 0x57F287,
    error:   0xED4245,
    warn:    0xFEE75C,
    info:    0x5865F2,
    neutral: 0x2B2D31,
    // Case status colors
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

// --- Embed Helpers ---
function simpleEmbed(color, title, description) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}

function infoEmbed(color, title, lines, thumbnail) {
    const e = new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n')).setTimestamp();
    if (thumbnail) e.setThumbnail(thumbnail);
    return e;
}

function errEmbed(msg) { return simpleEmbed(Colors.error, '❌ Error', msg); }

function ts(date) {
    let t = date ? new Date(date).getTime() : Date.now();
    if (isNaN(t)) t = Date.now();
    return `<t:${Math.floor(t / 1000)}:F>`;
}

// --- Parse Helpers ---
function parseDuration(str) {
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const ms = parseInt(match[1]) * mult[match[2].toLowerCase()];
    if (ms > 28 * 86400000 || ms < 5000) return null;
    return ms;
}

function msToHuman(ms) {
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

// --- Pagination ---
function buildPageButtons(page, maxPages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_page').setLabel('◀ Previous').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('next_page').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(page === maxPages - 1)
    );
}

function buildDisabledButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev_page').setLabel('◀ Previous').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('next_page').setLabel('Next ▶').setStyle(ButtonStyle.Primary).setDisabled(true)
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
            .setTitle(`${title} (Page ${page + 1} of ${maxPages}) — Total: ${rows.length}`)
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

// --- Confirmation Dialog ---
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

// --- DB Init ---
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
            judge_role_id           TEXT
        );

        CREATE TABLE IF NOT EXISTS cases (
            id                  SERIAL PRIMARY KEY,
            guild_id            TEXT NOT NULL,
            case_number         INT NOT NULL,
            status              TEXT NOT NULL DEFAULT 'FILED',
            prosecutor_id       TEXT NOT NULL,
            defendant_id        TEXT NOT NULL,
            reason              TEXT NOT NULL,
            judge_id            TEXT,
            prosecutor_lawyer_id TEXT,
            defense_lawyer_id   TEXT,
            scheduled_at        TIMESTAMPTZ,
            started_at          TIMESTAMPTZ,
            closed_at           TIMESTAMPTZ,
            verdict             TEXT,
            verdict_reason      TEXT,
            case_channel_id     TEXT,
            jury_chat_channel_id TEXT,
            judge_chat_channel_id TEXT,
            pinned_message_id   TEXT,
            evidence_count      INT DEFAULT 0,
            filed_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
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
            id          SERIAL PRIMARY KEY,
            case_id     INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            message_id  TEXT NOT NULL,
            author_id   TEXT NOT NULL,
            content     TEXT,
            struck       BOOLEAN DEFAULT FALSE,
            struck_by   TEXT,
            struck_reason TEXT,
            created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
    `);
    console.log('Database initialized.');
}

// --- Log Action ---
async function logAction(userId, action, reason, executorId) {
    await pool.query(
        'INSERT INTO action_history (user_id, action, reason, executor_id) VALUES ($1, $2, $3, $4)',
        [userId, action, reason || 'No reason provided.', executorId]
    ).catch(() => {});
}

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

// ============================================================
// --- CASE HELPERS ---
// ============================================================

async function getActiveCase(guildId) {
    const { rows } = await pool.query(
        `SELECT * FROM cases WHERE guild_id = $1 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') ORDER BY filed_at DESC LIMIT 1`,
        [guildId]
    );
    return rows[0] || null;
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

// Resolves a case from either a case ID string ("CASE-001", "001", "1") or a user mention/id (prosecutor or defendant)
async function resolveCase(guildId, input) {
    // Try case number
    const numMatch = input.match(/(\d+)/);
    if (numMatch) {
        const c = await getCaseByNumber(guildId, parseInt(numMatch[1]));
        if (c) return c;
    }
    // Try user id (prosecutor or defendant)
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

// ============================================================
// --- PINNED EMBED ---
// ============================================================

async function buildCaseEmbed(c) {
    const jury = await getJuryMembers(c.id);
    const juryList = jury.length
        ? jury.map(j => `<@${j.user_id}>`).join(', ')
        : 'No jury yet';

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
    }

    lines.push('');
    lines.push(`**Filed:** ${ts(c.filed_at)}`);
    lines.push(`**Reason:** ${c.reason}`);

    return new EmbedBuilder()
        .setColor(statusColor)
        .setTitle(`⚖️ ${formatCaseId(c.case_number)} — ${c.status}`)
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

// ============================================================
// --- DM HELPER ---
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

// ============================================================
// --- CHANNEL PERMISSION HELPERS ---
// ============================================================

async function buildCaseChannelPerms(guild, c, config) {
    // Everyone can read, participants can type
    const participantIds = [c.prosecutor_id, c.defendant_id];
    if (c.judge_id) participantIds.push(c.judge_id);
    if (c.prosecutor_lawyer_id) participantIds.push(c.prosecutor_lawyer_id);
    if (c.defense_lawyer_id) participantIds.push(c.defense_lawyer_id);

    const perms = [
        { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ];
    for (const id of participantIds) {
        perms.push({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    }
    return perms;
}

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
    // Lock everyone else too
    for (const [id, overwrite] of channel.permissionOverwrites.cache) {
        if (id !== channel.guild.roles.everyone.id) {
            await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
        }
    }
}

// ============================================================
// --- ARCHIVE HELPER ---
// ============================================================

async function archiveCase(c, guild, config, summaryEmbed) {
    try {
        // Move case channel to archive category
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

        // Post summary in court-records
        if (config.court_records_name) {
            const recordsChannel = guild.channels.cache.find(
                ch => ch.name === config.court_records_name && ch.type === ChannelType.GuildText
            );
            if (recordsChannel && summaryEmbed) {
                await recordsChannel.send({ embeds: [summaryEmbed] }).catch(() => {});
            }
        }

        // Update DB
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
    }
    if (closedBy) lines.push(`**Closed by:** ${closedBy}`);

    const color = STATUS_COLORS[c.status] || Colors.neutral;
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`📁 Case Closed — ${formatCaseId(c.case_number)}`)
        .setDescription(lines.join('\n'))
        .setTimestamp();
}

// ============================================================
// --- SCHEDULED CASE TIMERS ---
// ============================================================

const activeTimers = new Map(); // caseId → timeout handle

async function scheduleCase(c) {
    if (activeTimers.has(c.id)) {
        clearTimeout(activeTimers.get(c.id));
        activeTimers.delete(c.id);
    }
    if (!c.scheduled_at) return;
    const ms = new Date(c.scheduled_at).getTime() - Date.now();
    if (ms <= 0) {
        await startCaseNow(c.id);
        return;
    }
    const handle = setTimeout(() => startCaseNow(c.id), ms);
    activeTimers.set(c.id, handle);
}

async function startCaseNow(caseId) {
    activeTimers.delete(caseId);
    const c = await getCaseById(caseId);
    if (!c || c.status !== 'SCHEDULED') return;

    await pool.query(`UPDATE cases SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = $1`, [caseId]);
    const updated = await getCaseById(caseId);

    // Post in case channel
    if (updated.case_channel_id) {
        const ch = await client.channels.fetch(updated.case_channel_id).catch(() => null);
        if (ch) {
            await ch.send({ embeds: [simpleEmbed(Colors.in_progress, '⚖️ Court is Now in Session', `${formatCaseId(updated.case_number)} has officially begun. All parties, please take your positions.`)] });
        }
    }

    await updatePinnedEmbed(updated);

    // DM all participants
    const participants = await getCaseParticipants(updated);
    const dmEmbed = simpleEmbed(Colors.in_progress, '⚖️ Court is Now in Session', `${formatCaseId(updated.case_number)} has begun.`);
    await dmAll(participants, dmEmbed);

    await logAction(updated.guild_id, 'CASE_STARTED', formatCaseId(updated.case_number), client.user.id);
}

async function rehydrateTimers() {
    const { rows } = await pool.query(`SELECT * FROM cases WHERE status = 'SCHEDULED' AND scheduled_at > NOW()`);
    for (const c of rows) await scheduleCase(c);
    console.log(`Re-hydrated ${rows.length} scheduled case timer(s).`);
}

// ============================================================
// --- SETUP WIZARD ---
// ============================================================

const SETUP_STEPS = [
    { key: 'court_category_id',      label: 'Court Category ID',           hint: 'The category ID where active case channels will be created.' },
    { key: 'archive_category_id',    label: 'Archive Category ID',         hint: 'The category ID where closed case channels will be moved.' },
    { key: 'judge_chat_name',        label: 'Judge Chat Channel Name',     hint: 'Name for the judge-only channel (e.g. `judge-chat`).' },
    { key: 'court_records_name',     label: 'Court Records Channel Name',  hint: 'Name for the public records channel (e.g. `court-records`).' },
    { key: 'jury_chat_name',         label: 'Jury Chat Channel Name',      hint: 'Name for the jury channel (e.g. `jury-chat`).' },
    { key: 'case_channel_format',    label: 'Case Channel Name Format',    hint: 'Supports `{case_id}` and `{defendant}` (e.g. `courtcase-{case_id}`).' },
    { key: 'archive_channel_format', label: 'Archive Channel Name Format', hint: 'Supports `{case_id}` and `{defendant}` (e.g. `case-{case_id}-archive`).' },
    { key: 'judge_role_id',          label: 'Judge Role ID',               hint: 'The Discord role ID for judges.' },
];

const setupSessions = new Map(); // userId → { step, values, messageId }

function buildSetupEmbed(step, values, error) {
    const current = SETUP_STEPS[step];
    const lines = SETUP_STEPS.map((s, i) => {
        const val = values[s.key];
        const prefix = i < step ? '✅' : i === step ? '➡️' : '⬜';
        return `${prefix} **${s.label}:** ${val ? `\`${val}\`` : '*Not set*'}`;
    });
    lines.push('');
    lines.push(`**Current Step:** ${current.label}`);
    lines.push(`*${current.hint}*`);
    if (error) lines.push(`\n❌ ${error}`);
    return new EmbedBuilder()
        .setColor(Colors.info)
        .setTitle('⚙️ Court Bot Setup')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Step ${step + 1} of ${SETUP_STEPS.length}` })
        .setTimestamp();
}

function buildSetupRow(step) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`setup_set_${step}`)
            .setLabel(`Set: ${SETUP_STEPS[step].label}`)
            .setStyle(ButtonStyle.Primary),
    );
    if (step > 0) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('setup_back')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    row.addComponents(
        new ButtonBuilder()
            .setCustomId('setup_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
    );
    return row;
}

// ============================================================
// --- READY ---
// ============================================================

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
        { name: 'cancelcase', description: 'Cancel your active case', ...CMD_GUILD, options: [
            { name: 'reason', description: 'Reason for cancellation', type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Judge Commands
        { name: 'claimcase', description: 'Claim a case as judge', ...CMD_GUILD, options: [
            { name: 'case', description: 'Case ID or prosecutor mention', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'startcase', description: 'Schedule the case to go live', ...CMD_GUILD, options: [
            { name: 'time', description: 'Time from now (e.g. 1h, 30m)', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'postpone', description: 'Reschedule a case', ...CMD_GUILD, options: [
            { name: 'case',     description: 'Case ID or prosecutor mention', type: ApplicationCommandOptionType.String, required: true },
            { name: 'new_time', description: 'New time from now (e.g. 2h)',   type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'endcase', description: 'End a case manually', ...CMD_GUILD, options: [
            { name: 'case',   description: 'Case ID or prosecutor mention', type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason', description: 'Reason',                        type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'dismiss', description: 'Dismiss the active case', ...CMD_GUILD, options: [
            { name: 'reason', description: 'Reason for dismissal', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'verdict', description: 'Set the final verdict', ...CMD_GUILD, options: [
            { name: 'verdict', description: 'guilty or not guilty', type: ApplicationCommandOptionType.String, required: true,
              choices: [{ name: 'Guilty', value: 'GUILTY' }, { name: 'Not Guilty', value: 'NOT GUILTY' }] },
            { name: 'reason', description: 'Charges or reason', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'assignjudge', description: 'Assign the judge role to a user (admin only)', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to assign', type: ApplicationCommandOptionType.User, required: true },
        ]},
        { name: 'revokejudge', description: 'Remove the judge role from a user (admin only)', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to revoke', type: ApplicationCommandOptionType.User, required: true },
        ]},

        // Lawyer Commands
        { name: 'requestlawyer', description: 'Request a user to be your lawyer', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to request', type: ApplicationCommandOptionType.User, required: true },
        ]},
        { name: 'revokelawyer', description: 'Fire your current lawyer', ...CMD_GUILD, options: [
            { name: 'reason', description: 'Reason', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'acceptlawyer', description: 'Accept a lawyer request', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID (e.g. 1 or CASE-001)', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'declinelawyer', description: 'Decline a lawyer request', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID (e.g. 1 or CASE-001)', type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Jury Commands
        { name: 'joinjury', description: 'Volunteer to join the jury', ...CMD_GUILD, options: [
            { name: 'case_id', description: 'Case ID', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'vote', description: 'Cast your jury vote', ...CMD_GUILD, options: [
            { name: 'vote',   description: 'Your vote',  type: ApplicationCommandOptionType.String, required: true,
              choices: [{ name: 'Guilty', value: 'GUILTY' }, { name: 'Not Guilty', value: 'NOT GUILTY' }] },
            { name: 'reason', description: 'Your reasoning', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'jurytally', description: 'View the current jury vote tally (judge only)', ...CMD_GUILD },

        // Evidence
        { name: 'strikeevidence', description: 'Strike a message from the evidence log', ...CMD_GUILD, options: [
            { name: 'message_id', description: 'The message ID to strike', type: ApplicationCommandOptionType.String, required: true },
            { name: 'reason',     description: 'Reason',                   type: ApplicationCommandOptionType.String, required: true },
        ]},

        // Info
        { name: 'caseinfo',    description: 'View full case details', ...CMD_GUILD, options: [
            { name: 'case', description: 'Case ID or user mention', type: ApplicationCommandOptionType.String, required: true },
        ]},
        { name: 'activecases', description: 'View the current active case', ...CMD_GUILD },
        { name: 'casehistory', description: 'View a user\'s case history', ...CMD_GUILD, options: [
            { name: 'user', description: 'User to look up', type: ApplicationCommandOptionType.User, required: true },
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
                };
                setupSessions.set(interaction.user.id, { step: 0, values, guildId });
                const msg = await interaction.editReply({
                    embeds: [buildSetupEmbed(0, values)],
                    components: [buildSetupRow(0)],
                });
                return;
            }

            // ================================================================
            // /courtconfig
            // ================================================================
            if (cmd === 'courtconfig') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config) return interaction.editReply({ embeds: [errEmbed('No configuration found. Run `/setup` first.')] });

                const lines = [
                    `**Court Category:** ${config.court_category_id ? `<#${config.court_category_id}>` : '*Not set*'}`,
                    `**Archive Category:** ${config.archive_category_id ? `<#${config.archive_category_id}>` : '*Not set*'}`,
                    `**Judge Chat Name:** \`${config.judge_chat_name || 'Not set'}\``,
                    `**Court Records Name:** \`${config.court_records_name || 'Not set'}\``,
                    `**Jury Chat Name:** \`${config.jury_chat_name || 'Not set'}\``,
                    `**Case Channel Format:** \`${config.case_channel_format || 'Not set'}\``,
                    `**Archive Channel Format:** \`${config.archive_channel_format || 'Not set'}\``,
                    `**Judge Role:** ${config.judge_role_id ? `<@&${config.judge_role_id}>` : '*Not set*'}`,
                ];
                return interaction.editReply({ embeds: [infoEmbed(Colors.info, '⚙️ Court Configuration', lines)] });
            }

            // ================================================================
            // /filecase
            // ================================================================
            if (cmd === 'filecase') {
                const config = await getConfig(guildId);
                if (!config?.court_category_id) return interaction.editReply({ embeds: [errEmbed('Court not configured. Run `/setup` first.')] });

                const defendant = interaction.options.getUser('user');
                const reason = interaction.options.getString('reason');

                if (defendant.id === interaction.user.id)
                    return interaction.editReply({ embeds: [errEmbed('You cannot file a case against yourself.')] });
                if (defendant.bot)
                    return interaction.editReply({ embeds: [errEmbed('You cannot file a case against a bot.')] });

                const existing = await getActiveCase(guildId);
                if (existing) return interaction.editReply({ embeds: [errEmbed(`There is already an active case: **${formatCaseId(existing.case_number)}**. Only one case can be active at a time.`)] });

                // Get next case number
                const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM cases WHERE guild_id = $1', [guildId]);
                const caseNumber = parseInt(countRows[0].count) + 1;

                const { rows: insertRows } = await pool.query(
                    `INSERT INTO cases (guild_id, case_number, prosecutor_id, defendant_id, reason, status)
                     VALUES ($1, $2, $3, $4, $5, 'FILED') RETURNING *`,
                    [guildId, caseNumber, interaction.user.id, defendant.id, reason]
                );
                const c = insertRows[0];

                // Create channels
                const guild = interaction.guild;
                const channelName = resolveChannelName(config.case_channel_format, caseNumber, defendant.id);

                // Build initial permissions for case channel
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
                });

                // Create jury-chat
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

                // Create judge-chat
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

                // Update DB with channel IDs
                await pool.query(
                    `UPDATE cases SET case_channel_id = $1, jury_chat_channel_id = $2, judge_chat_channel_id = $3 WHERE id = $4`,
                    [caseChannel.id, juryChat.id, judgeChat.id, c.id]
                );

                // Pin the case embed
                const pinnedMsg = await caseChannel.send({ embeds: [await buildCaseEmbed({ ...c, case_channel_id: caseChannel.id, jury_chat_channel_id: juryChat.id, judge_chat_channel_id: judgeChat.id })] });
                await pinnedMsg.pin();
                await pool.query('UPDATE cases SET pinned_message_id = $1 WHERE id = $2', [pinnedMsg.id, c.id]);

                // Post in court-records
                const recordsChannel = guild.channels.cache.find(ch => ch.name === config.court_records_name && ch.type === ChannelType.GuildText);
                if (recordsChannel) {
                    await recordsChannel.send({ embeds: [simpleEmbed(Colors.filed, `📋 New Case Filed — ${formatCaseId(caseNumber)}`, `**Prosecutor:** <@${interaction.user.id}>\n**Defendant:** <@${defendant.id}>\n**Reason:** ${reason}\n\nCase channel: ${caseChannel}`)] });
                }

                // DM defendant
                await dmUser(defendant.id, simpleEmbed(Colors.warn, '⚖️ You Have Been Sued', `<@${interaction.user.id}> has filed a case against you in **${guild.name}**.\n\n**Reason:** ${reason}\n**Case:** ${formatCaseId(caseNumber)}\n\nCase channel: ${caseChannel}`));

                await logAction(defendant.id, 'CASE_FILED', reason, interaction.user.id);

                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Filed', `**${formatCaseId(caseNumber)}** has been filed.\nCase channel: ${caseChannel}`)] });
            }

            // ================================================================
            // /cancelcase
            // ================================================================
            if (cmd === 'cancelcase') {
                const reason = interaction.options.getString('reason');
                const { rows } = await pool.query(
                    `SELECT * FROM cases WHERE guild_id = $1 AND prosecutor_id = $2 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED') ORDER BY filed_at DESC LIMIT 1`,
                    [guildId, interaction.user.id]
                );
                const c = rows[0];
                if (!c) return interaction.editReply({ embeds: [errEmbed('You have no active case to cancel.')] });

                const ok = await confirm(interaction, '⚠️ Cancel Case', `Are you sure you want to cancel **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'CANCELLED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const config = await getConfig(guildId);
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}>`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.warn, '⚠️ Case Cancelled', `**${formatCaseId(c.case_number)}** has been cancelled by the prosecutor.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_CANCELLED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Cancelled', `**${formatCaseId(c.case_number)}** has been cancelled.`)] });
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

                const caseInput = interaction.options.getString('case');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (c.status !== 'FILED') return interaction.editReply({ embeds: [errEmbed(`Case is not in FILED status (current: ${c.status}).`)] });

                // Check judge not already on a case
                const { rows: judgeCheck } = await pool.query(
                    `SELECT * FROM cases WHERE guild_id = $1 AND judge_id = $2 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED')`,
                    [guildId, interaction.user.id]
                );
                if (judgeCheck.length) return interaction.editReply({ embeds: [errEmbed('You are already assigned to an active case.')] });

                const newStatus = (!c.prosecutor_lawyer_id || !c.defense_lawyer_id) ? 'WAITING_LAWYERS' : 'ASSIGNED';
                await pool.query(`UPDATE cases SET judge_id = $1, status = $2 WHERE id = $3`, [interaction.user.id, newStatus, c.id]);
                const updated = await getCaseById(c.id);

                // Give judge access to case channel and judge-chat
                const guild = interaction.guild;
                if (updated.case_channel_id) {
                    const ch = await guild.channels.fetch(updated.case_channel_id).catch(() => null);
                    if (ch) await addParticipantToChannel(ch, interaction.user.id);
                }
                if (updated.judge_chat_channel_id) {
                    const jch = await guild.channels.fetch(updated.judge_chat_channel_id).catch(() => null);
                    if (jch) await addParticipantToChannel(jch, interaction.user.id);
                }
                // Give judge access to jury-chat
                if (updated.jury_chat_channel_id) {
                    const jrch = await guild.channels.fetch(updated.jury_chat_channel_id).catch(() => null);
                    if (jrch) await addParticipantToChannel(jrch, interaction.user.id);
                }

                await updatePinnedEmbed(updated);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.assigned, '👨‍⚖️ Judge Assigned', `<@${interaction.user.id}> has claimed **${formatCaseId(c.case_number)}** as the presiding judge.`));

                await logAction(interaction.user.id, 'JUDGE_CLAIMED', formatCaseId(c.case_number), interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Claimed', `You are now the judge for **${formatCaseId(c.case_number)}**.`)] });
            }

            // ================================================================
            // /startcase
            // ================================================================
            if (cmd === 'startcase') {
                const config = await getConfig(guildId);
                const timeStr = interaction.options.getString('time');
                const ms = parseDuration(timeStr);
                if (!ms) return interaction.editReply({ embeds: [errEmbed('Invalid time format. Use e.g. `1h`, `30m`, `2h`.')] });

                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });
                if (c.status !== 'ASSIGNED' && c.status !== 'WAITING_LAWYERS') return interaction.editReply({ embeds: [errEmbed(`Case must be ASSIGNED or WAITING_LAWYERS to schedule (current: ${c.status}).`)] });
                if (!c.prosecutor_lawyer_id || !c.defense_lawyer_id) return interaction.editReply({ embeds: [errEmbed('Both sides must have a lawyer before the case can be scheduled.')] });

                const scheduledAt = new Date(Date.now() + ms);
                await pool.query(`UPDATE cases SET status = 'SCHEDULED', scheduled_at = $1 WHERE id = $2`, [scheduledAt, c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);
                await scheduleCase(updated);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.scheduled, '📅 Case Scheduled', `**${formatCaseId(c.case_number)}** is scheduled to begin ${ts(scheduledAt)}.`));

                await logAction(interaction.user.id, 'CASE_SCHEDULED', `${formatCaseId(c.case_number)} at ${scheduledAt.toISOString()}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Scheduled', `**${formatCaseId(c.case_number)}** will go live ${ts(scheduledAt)}.`)] });
            }

            // ================================================================
            // /postpone
            // ================================================================
            if (cmd === 'postpone') {
                const caseInput = interaction.options.getString('case');
                const newTimeStr = interaction.options.getString('new_time');
                const ms = parseDuration(newTimeStr);
                if (!ms) return interaction.editReply({ embeds: [errEmbed('Invalid time format.')] });

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
                await dmAll(participants, simpleEmbed(Colors.warn, '📅 Case Postponed', `**${formatCaseId(c.case_number)}** has been rescheduled to ${ts(newTime)}.`));

                await logAction(interaction.user.id, 'CASE_POSTPONED', `${formatCaseId(c.case_number)} → ${newTime.toISOString()}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Postponed', `**${formatCaseId(c.case_number)}** rescheduled to ${ts(newTime)}.`)] });
            }

            // ================================================================
            // /endcase
            // ================================================================
            if (cmd === 'endcase') {
                const config = await getConfig(guildId);
                const caseInput = interaction.options.getString('case');
                const reason = interaction.options.getString('reason');

                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });

                const isJudge = c.judge_id === interaction.user.id;
                if (!isJudge && !isAdmin) return interaction.editReply({ embeds: [errEmbed('Only the presiding judge or an admin can end this case.')] });

                const ok = await confirm(interaction, '⚠️ End Case', `Are you sure you want to end **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'CLOSED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}>`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.neutral, '⚖️ Case Ended', `**${formatCaseId(c.case_number)}** has been closed by <@${interaction.user.id}>.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_ENDED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Ended', `**${formatCaseId(c.case_number)}** has been closed.`)] });
            }

            // ================================================================
            // /dismiss
            // ================================================================
            if (cmd === 'dismiss') {
                const config = await getConfig(guildId);
                const reason = interaction.options.getString('reason');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });

                const ok = await confirm(interaction, '⚠️ Dismiss Case', `Are you sure you want to dismiss **${formatCaseId(c.case_number)}**?\nReason: ${reason}`);
                if (!ok) return;

                await pool.query(`UPDATE cases SET status = 'DISMISSED' WHERE id = $1`, [c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                const guild = interaction.guild;
                const summary = buildSummaryEmbed(updated, `<@${interaction.user.id}> (dismissed)`);
                await archiveCase(updated, guild, config, summary);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, simpleEmbed(Colors.neutral, '⚖️ Case Dismissed', `**${formatCaseId(c.case_number)}** has been dismissed by the judge.\n**Reason:** ${reason}`));

                await logAction(interaction.user.id, 'CASE_DISMISSED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Case Dismissed', `**${formatCaseId(c.case_number)}** has been dismissed.`)] });
            }

            // ================================================================
            // /verdict
            // ================================================================
            if (cmd === 'verdict') {
                const config = await getConfig(guildId);
                const verdictValue = interaction.options.getString('verdict');
                const reason = interaction.options.getString('reason');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case found.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('You are not the judge on this case.')] });
                if (c.status !== 'IN_PROGRESS') return interaction.editReply({ embeds: [errEmbed('Case must be IN_PROGRESS to set a verdict.')] });

                await pool.query(`UPDATE cases SET status = 'VERDICT', verdict = $1, verdict_reason = $2 WHERE id = $3`, [verdictValue, reason, c.id]);
                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                // Post verdict embed in case channel
                const guild = interaction.guild;
                if (updated.case_channel_id) {
                    const ch = await guild.channels.fetch(updated.case_channel_id).catch(() => null);
                    if (ch) {
                        await ch.send({ embeds: [new EmbedBuilder()
                            .setColor(verdictValue === 'GUILTY' ? Colors.error : Colors.success)
                            .setTitle(`⚖️ Verdict — ${formatCaseId(c.case_number)}`)
                            .setDescription(`**Verdict:** \`${verdictValue}\`\n**Reason:** ${reason}\n**Judge:** <@${interaction.user.id}>`)
                            .setTimestamp()
                        ] });
                    }
                }

                // Archive
                await pool.query(`UPDATE cases SET status = 'CLOSED' WHERE id = $1`, [c.id]);
                const closed = await getCaseById(c.id);
                const summary = buildSummaryEmbed(closed, `Verdict by <@${interaction.user.id}>`);
                await archiveCase(closed, guild, config, summary);
                await updatePinnedEmbed(closed);

                const participants = await getCaseParticipants(updated);
                await dmAll(participants, new EmbedBuilder()
                    .setColor(verdictValue === 'GUILTY' ? Colors.error : Colors.success)
                    .setTitle(`⚖️ Verdict Set — ${formatCaseId(c.case_number)}`)
                    .setDescription(`**Verdict:** \`${verdictValue}\`\n**Reason:** ${reason}`)
                    .setTimestamp()
                );

                await logAction(c.defendant_id, `VERDICT_${verdictValue}`, reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Verdict Set', `**${formatCaseId(c.case_number)}** — \`${verdictValue}\`. Case archived.`)] });
            }

            // ================================================================
            // /assignjudge
            // ================================================================
            if (cmd === 'assignjudge') {
                if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] });
                const config = await getConfig(guildId);
                if (!config?.judge_role_id) return interaction.editReply({ embeds: [errEmbed('Judge role not configured. Run `/setup` first.')] });
                const user = interaction.options.getUser('user');
                const member = await interaction.guild.members.fetch(user.id).catch(() => null);
                if (!member) return interaction.editReply({ embeds: [errEmbed('Member not found.')] });
                await member.roles.add(config.judge_role_id);
                await logAction(user.id, 'JUDGE_ASSIGNED', null, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Judge Role Assigned', `<@${user.id}> is now a judge.`)] });
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
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Judge Role Revoked', `<@${user.id}> is no longer a judge.`)] });
            }

            // ================================================================
            // /requestlawyer
            // ================================================================
            if (cmd === 'requestlawyer') {
                const targetUser = interaction.options.getUser('user');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case found.')] });

                const isProsecutor = c.prosecutor_id === interaction.user.id;
                const isDefendant  = c.defendant_id  === interaction.user.id;
                if (!isProsecutor && !isDefendant) return interaction.editReply({ embeds: [errEmbed('Only the prosecutor or defendant can request a lawyer.')] });

                const side = isProsecutor ? 'prosecution' : 'defense';
                const alreadyHas = isProsecutor ? c.prosecutor_lawyer_id : c.defense_lawyer_id;
                if (alreadyHas) return interaction.editReply({ embeds: [errEmbed(`You already have a lawyer assigned.`)] });

                if (targetUser.id === c.prosecutor_id || targetUser.id === c.defendant_id)
                    return interaction.editReply({ embeds: [errEmbed('A case participant cannot be a lawyer.')] });
                if (targetUser.bot)
                    return interaction.editReply({ embeds: [errEmbed('A bot cannot be a lawyer.')] });

                // Check if target is already lawyering another active case
                const { rows: lawyerCheck } = await pool.query(
                    `SELECT * FROM cases WHERE guild_id = $1 AND (prosecutor_lawyer_id = $2 OR defense_lawyer_id = $2) AND status NOT IN ('CLOSED','CANCELLED','DISMISSED')`,
                    [guildId, targetUser.id]
                );
                if (lawyerCheck.length) return interaction.editReply({ embeds: [errEmbed(`<@${targetUser.id}> is already a lawyer on an active case.`)] });

                // Check for existing pending request
                const { rows: existingReq } = await pool.query(
                    `SELECT * FROM lawyer_requests WHERE case_id = $1 AND side = $2 AND status = 'PENDING'`,
                    [c.id, side]
                );
                if (existingReq.length) return interaction.editReply({ embeds: [errEmbed('There is already a pending lawyer request for this side.')] });

                await pool.query(
                    `INSERT INTO lawyer_requests (case_id, requester_id, requested_id, side) VALUES ($1, $2, $3, $4)`,
                    [c.id, interaction.user.id, targetUser.id, side]
                );

                // Post in case channel
                if (c.case_channel_id) {
                    const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) {
                        await ch.send({ embeds: [simpleEmbed(Colors.info, '👤 Lawyer Requested', `<@${interaction.user.id}> has requested <@${targetUser.id}> as their lawyer (${side}).\nAwaiting response.`)] });
                    }
                }

                // DM the requested user with accept/decline buttons
                const dmEmbed = simpleEmbed(Colors.info, '⚖️ Lawyer Request', `<@${interaction.user.id}> is requesting you to be their lawyer for the **${side}** in **${formatCaseId(c.case_number)}** in **${interaction.guild.name}**.\n\nUse \`/acceptlawyer ${c.case_number}\` to accept or \`/declinelawyer ${c.case_number}\` to decline.`);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`accept_lawyer_${c.id}_${side}`).setLabel('Accept').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`decline_lawyer_${c.id}_${side}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
                );
                try {
                    const dmChannel = await targetUser.createDM();
                    await dmChannel.send({ embeds: [dmEmbed], components: [row] });
                } catch {
                    // DMs closed — fallback already handled by slash command
                }

                await logAction(targetUser.id, 'LAWYER_REQUESTED', `${side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Lawyer Requested', `Request sent to <@${targetUser.id}>.`)] });
            }

            // ================================================================
            // /revokelawyer
            // ================================================================
            if (cmd === 'revokelawyer') {
                const reason = interaction.options.getString('reason');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case found.')] });

                const isProsecutor = c.prosecutor_id === interaction.user.id;
                const isDefendant  = c.defendant_id  === interaction.user.id;
                if (!isProsecutor && !isDefendant) return interaction.editReply({ embeds: [errEmbed('Only the prosecutor or defendant can revoke a lawyer.')] });

                const lawyerId = isProsecutor ? c.prosecutor_lawyer_id : c.defense_lawyer_id;
                if (!lawyerId) return interaction.editReply({ embeds: [errEmbed('You do not have a lawyer to revoke.')] });

                const field = isProsecutor ? 'prosecutor_lawyer_id' : 'defense_lawyer_id';
                await pool.query(`UPDATE cases SET ${field} = NULL WHERE id = $1`, [c.id]);

                // Revert status if was SCHEDULED back to WAITING_LAWYERS
                const updated = await getCaseById(c.id);
                if (['SCHEDULED', 'ASSIGNED'].includes(updated.status)) {
                    await pool.query(`UPDATE cases SET status = 'WAITING_LAWYERS' WHERE id = $1`, [c.id]);
                    if (activeTimers.has(c.id)) {
                        clearTimeout(activeTimers.get(c.id));
                        activeTimers.delete(c.id);
                    }
                }
                const final = await getCaseById(c.id);
                await updatePinnedEmbed(final);

                // Remove lawyer from case channel
                if (c.case_channel_id) {
                    const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await removeParticipantFromChannel(ch, lawyerId);
                }

                await dmUser(lawyerId, simpleEmbed(Colors.warn, '⚖️ Lawyer Revoked', `You have been removed as a lawyer from **${formatCaseId(c.case_number)}**.\n**Reason:** ${reason}`));

                await logAction(lawyerId, 'LAWYER_REVOKED', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Lawyer Revoked', `<@${lawyerId}> has been removed as your lawyer.`)] });
            }

            // ================================================================
            // /acceptlawyer
            // ================================================================
            if (cmd === 'acceptlawyer') {
                const caseInput = interaction.options.getString('case_id');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });

                const { rows: reqRows } = await pool.query(
                    `SELECT * FROM lawyer_requests WHERE case_id = $1 AND requested_id = $2 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
                    [c.id, interaction.user.id]
                );
                if (!reqRows.length) return interaction.editReply({ embeds: [errEmbed('No pending lawyer request for you on this case.')] });
                const req = reqRows[0];

                await _assignLawyer(c, req, interaction.user.id, interaction.guild);
                await pool.query(`UPDATE lawyer_requests SET status = 'ACCEPTED' WHERE id = $1`, [req.id]);

                await logAction(interaction.user.id, 'LAWYER_ACCEPTED', `${req.side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Lawyer Accepted', `You are now the ${req.side} lawyer for **${formatCaseId(c.case_number)}**.`)] });
            }

            // ================================================================
            // /declinelawyer
            // ================================================================
            if (cmd === 'declinelawyer') {
                const caseInput = interaction.options.getString('case_id');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });

                const { rows: reqRows } = await pool.query(
                    `SELECT * FROM lawyer_requests WHERE case_id = $1 AND requested_id = $2 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
                    [c.id, interaction.user.id]
                );
                if (!reqRows.length) return interaction.editReply({ embeds: [errEmbed('No pending lawyer request for you on this case.')] });
                const req = reqRows[0];

                await pool.query(`UPDATE lawyer_requests SET status = 'DECLINED' WHERE id = $1`, [req.id]);

                // Notify requester
                await dmUser(req.requester_id, simpleEmbed(Colors.warn, '❌ Lawyer Request Declined', `<@${interaction.user.id}> has declined your lawyer request for **${formatCaseId(c.case_number)}** (${req.side}).`));

                // Post in case channel
                if (c.case_channel_id) {
                    const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, '❌ Lawyer Request Declined', `<@${interaction.user.id}> has declined the lawyer request for the ${req.side}.`)] });
                }

                await logAction(interaction.user.id, 'LAWYER_DECLINED', `${req.side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Request Declined', `You have declined the lawyer request for **${formatCaseId(c.case_number)}**.`)] });
            }

            // ================================================================
            // /joinjury
            // ================================================================
            if (cmd === 'joinjury') {
                const caseInput = interaction.options.getString('case_id');
                const c = await resolveCase(guildId, caseInput);
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });
                if (!['FILED', 'ASSIGNED', 'WAITING_LAWYERS', 'SCHEDULED'].includes(c.status))
                    return interaction.editReply({ embeds: [errEmbed('Jury can only be joined before the case starts.')] });

                const userId = interaction.user.id;
                if ([c.prosecutor_id, c.defendant_id, c.judge_id, c.prosecutor_lawyer_id, c.defense_lawyer_id].includes(userId))
                    return interaction.editReply({ embeds: [errEmbed('Case participants cannot join the jury.')] });

                const jury = await getJuryMembers(c.id);
                if (jury.length >= MAX_JURY) return interaction.editReply({ embeds: [errEmbed(`The jury is full (max ${MAX_JURY}).`)] });
                if (jury.some(j => j.user_id === userId)) return interaction.editReply({ embeds: [errEmbed('You are already on the jury.')] });

                await pool.query('INSERT INTO jury_members (case_id, user_id) VALUES ($1, $2)', [c.id, userId]);

                // Give jury member access to jury-chat
                if (c.jury_chat_channel_id) {
                    const jch = await client.channels.fetch(c.jury_chat_channel_id).catch(() => null);
                    if (jch) await addParticipantToChannel(jch, userId);
                }

                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                // Post in case channel
                if (c.case_channel_id) {
                    const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await ch.send({ embeds: [simpleEmbed(Colors.success, '🧑‍⚖️ Jury Member Joined', `<@${userId}> has joined the jury for **${formatCaseId(c.case_number)}**. (${jury.length + 1}/${MAX_JURY})`)] });
                }

                await logAction(userId, 'JURY_JOINED', formatCaseId(c.case_number), userId);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Joined Jury', `You are now on the jury for **${formatCaseId(c.case_number)}**.`)] });
            }

            // ================================================================
            // /vote
            // ================================================================
            if (cmd === 'vote') {
                const voteValue = interaction.options.getString('vote');
                const voteReason = interaction.options.getString('reason');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case.')] });
                if (c.status !== 'IN_PROGRESS') return interaction.editReply({ embeds: [errEmbed('Voting is only allowed during IN_PROGRESS.')] });

                const jury = await getJuryMembers(c.id);
                const member = jury.find(j => j.user_id === interaction.user.id);
                if (!member) return interaction.editReply({ embeds: [errEmbed('You are not on the jury for this case.')] });
                if (member.vote) return interaction.editReply({ embeds: [errEmbed('You have already voted.')] });

                await pool.query(
                    `UPDATE jury_members SET vote = $1, vote_reason = $2, voted_at = NOW() WHERE id = $3`,
                    [voteValue, voteReason, member.id]
                );

                // Post in jury-chat
                if (c.jury_chat_channel_id) {
                    const jch = await client.channels.fetch(c.jury_chat_channel_id).catch(() => null);
                    if (jch) await jch.send({ embeds: [simpleEmbed(Colors.info, '🗳️ Vote Cast', `<@${interaction.user.id}> has cast their vote.`)] });
                }

                await logAction(interaction.user.id, `JURY_VOTE_${voteValue}`, formatCaseId(c.case_number), interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Vote Cast', 'Your vote has been recorded.')] });
            }

            // ================================================================
            // /jurytally
            // ================================================================
            if (cmd === 'jurytally') {
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('Only the presiding judge can view the tally.')] });

                const jury = await getJuryMembers(c.id);
                const guilty    = jury.filter(j => j.vote === 'GUILTY').length;
                const notGuilty = jury.filter(j => j.vote === 'NOT GUILTY').length;
                const pending   = jury.filter(j => !j.vote).length;

                const lines = [
                    `**Case:** ${formatCaseId(c.case_number)}`,
                    `**Total Jurors:** ${jury.length}`,
                    '',
                    `🔴 **Guilty:** ${guilty}`,
                    `🟢 **Not Guilty:** ${notGuilty}`,
                    `⬜ **Pending:** ${pending}`,
                ];

                // Show individual votes
                if (jury.length) {
                    lines.push('');
                    lines.push('**Individual Votes:**');
                    for (const j of jury) {
                        lines.push(`<@${j.user_id}>: ${j.vote ? `\`${j.vote}\`` : '*Not yet voted*'}${j.vote_reason ? ` — ${j.vote_reason}` : ''}`);
                    }
                }

                // Edit reply as ephemeral-style by sending to judge DM if possible
                await interaction.editReply({ embeds: [infoEmbed(Colors.info, '🗳️ Jury Tally', lines)] });
                return;
            }

            // ================================================================
            // /strikeevidence
            // ================================================================
            if (cmd === 'strikeevidence') {
                const messageId = interaction.options.getString('message_id');
                const reason    = interaction.options.getString('reason');
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [errEmbed('No active case.')] });
                if (c.judge_id !== interaction.user.id) return interaction.editReply({ embeds: [errEmbed('Only the presiding judge can strike evidence.')] });

                const { rows: evRows } = await pool.query(
                    `SELECT * FROM evidence WHERE case_id = $1 AND message_id = $2`,
                    [c.id, messageId]
                );
                if (!evRows.length) return interaction.editReply({ embeds: [errEmbed('Message not found in evidence log.')] });
                if (evRows[0].struck) return interaction.editReply({ embeds: [errEmbed('This evidence has already been struck.')] });

                await pool.query(
                    `UPDATE evidence SET struck = TRUE, struck_by = $1, struck_reason = $2 WHERE message_id = $3 AND case_id = $4`,
                    [interaction.user.id, reason, messageId, c.id]
                );
                await pool.query(`UPDATE cases SET evidence_count = evidence_count - 1 WHERE id = $1`, [c.id]);

                const updated = await getCaseById(c.id);
                await updatePinnedEmbed(updated);

                // Post notice in case channel
                if (c.case_channel_id) {
                    const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, '🚫 Evidence Struck', `Message \`${messageId}\` has been struck from the evidence log.\n**Reason:** ${reason}\n**By:** <@${interaction.user.id}>`)] });
                }

                await logAction(interaction.user.id, 'EVIDENCE_STRUCK', reason, interaction.user.id);
                return interaction.editReply({ embeds: [simpleEmbed(Colors.success, '✅ Evidence Struck', `Message \`${messageId}\` removed from evidence log.`)] });
            }

            // ================================================================
            // /caseinfo
            // ================================================================
            if (cmd === 'caseinfo') {
                const caseInput = interaction.options.getString('case');
                let c = await resolveCase(guildId, caseInput);
                // Also check closed cases
                if (!c) {
                    const numMatch = caseInput.match(/(\d+)/);
                    if (numMatch) c = await getCaseByNumber(guildId, parseInt(numMatch[1]));
                }
                if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] });

                const jury = await getJuryMembers(c.id);
                const juryList = jury.length ? jury.map(j => `<@${j.user_id}>${j.vote ? ` (\`${j.vote}\`)` : ''}`).join(', ') : 'No jury';

                const lines = [
                    `**Case ID:** ${formatCaseId(c.case_number)}`,
                    `**Status:** \`${c.status}\``,
                    `**Filed:** ${ts(c.filed_at)}`,
                    `**Reason:** ${c.reason}`,
                    '',
                    `**Prosecutor:** <@${c.prosecutor_id}>`,
                    `**Prosecutor's Lawyer:** ${c.prosecutor_lawyer_id ? `<@${c.prosecutor_lawyer_id}>` : '*None*'}`,
                    `**Defendant:** <@${c.defendant_id}>`,
                    `**Defense Lawyer:** ${c.defense_lawyer_id ? `<@${c.defense_lawyer_id}>` : '*None*'}`,
                    `**Judge:** ${c.judge_id ? `<@${c.judge_id}>` : '*None*'}`,
                    '',
                    `**Jury (${jury.length}/${MAX_JURY}):** ${juryList}`,
                    `**Scheduled:** ${c.scheduled_at ? ts(c.scheduled_at) : '*N/A*'}`,
                    `**Evidence Count:** ${c.evidence_count}`,
                ];
                if (c.verdict) {
                    lines.push('');
                    lines.push(`**Verdict:** \`${c.verdict}\``);
                    lines.push(`**Verdict Reason:** ${c.verdict_reason}`);
                }
                if (c.closed_at) lines.push(`**Closed:** ${ts(c.closed_at)}`);

                const color = STATUS_COLORS[c.status] || Colors.neutral;
                return interaction.editReply({ embeds: [infoEmbed(color, `⚖️ ${formatCaseId(c.case_number)}`, lines)] });
            }

            // ================================================================
            // /activecases
            // ================================================================
            if (cmd === 'activecases') {
                const c = await getActiveCase(guildId);
                if (!c) return interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, '⚖️ Active Cases', 'No active cases right now.')] });

                const lines = [
                    `**Case:** ${formatCaseId(c.case_number)}`,
                    `**Status:** \`${c.status}\``,
                    `**Prosecutor:** <@${c.prosecutor_id}>`,
                    `**Defendant:** <@${c.defendant_id}>`,
                    `**Judge:** ${c.judge_id ? `<@${c.judge_id}>` : '*Not assigned*'}`,
                    `**Filed:** ${ts(c.filed_at)}`,
                    c.case_channel_id ? `**Channel:** <#${c.case_channel_id}>` : '',
                ].filter(Boolean);

                const color = STATUS_COLORS[c.status] || Colors.neutral;
                return interaction.editReply({ embeds: [infoEmbed(color, '⚖️ Active Case', lines)] });
            }

            // ================================================================
            // /casehistory
            // ================================================================
            if (cmd === 'casehistory') {
                const user = interaction.options.getUser('user');
                const { rows } = await pool.query(
                    `SELECT * FROM cases WHERE guild_id = $1 AND (prosecutor_id = $2 OR defendant_id = $2 OR judge_id = $2 OR prosecutor_lawyer_id = $2 OR defense_lawyer_id = $2) ORDER BY filed_at DESC`,
                    [guildId, user.id]
                );
                // Also check jury
                const { rows: juryRows } = await pool.query(
                    `SELECT c.* FROM cases c JOIN jury_members j ON j.case_id = c.id WHERE c.guild_id = $1 AND j.user_id = $2`,
                    [guildId, user.id]
                );
                const allIds = new Set(rows.map(r => r.id));
                const combined = [...rows];
                for (const r of juryRows) if (!allIds.has(r.id)) combined.push(r);
                combined.sort((a, b) => new Date(b.filed_at) - new Date(a.filed_at));

                if (!combined.length) return interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, '📂 Case History', `No cases found for <@${user.id}>.`)] });

                await paginatedReply(
                    interaction, combined, 5, Colors.info,
                    `Case History — ${user.tag}`,
                    (c) => {
                        const roleList = [];
                        if (c.prosecutor_id === user.id) roleList.push('Prosecutor');
                        if (c.defendant_id === user.id) roleList.push('Defendant');
                        if (c.judge_id === user.id) roleList.push('Judge');
                        if (c.prosecutor_lawyer_id === user.id) roleList.push("Prosecutor's Lawyer");
                        if (c.defense_lawyer_id === user.id) roleList.push('Defense Lawyer');
                        return `**${formatCaseId(c.case_number)}** — \`${c.status}\`\nRole: ${roleList.join(', ') || 'Jury'}\nFiled: ${ts(c.filed_at)}${c.verdict ? `\nVerdict: \`${c.verdict}\`` : ''}`;
                    }
                );
                return;
            }

        } catch (error) {
            console.error('Command error:', error);
            return interaction.editReply({ embeds: [errEmbed(`An unexpected error occurred.\n\`${error.message}\``)] });
        }
    }

    // ---- BUTTON INTERACTIONS ----
    if (interaction.isButton()) {
        const id = interaction.customId;

        // ================================================================
        // SETUP WIZARD BUTTONS
        // ================================================================
        if (id.startsWith('setup_')) {
            const session = setupSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: 'Session expired. Run `/setup` again.', ephemeral: true });

            if (id === 'setup_cancel') {
                setupSessions.delete(interaction.user.id);
                await interaction.update({
                    embeds: [simpleEmbed(Colors.neutral, 'Setup Cancelled', 'Setup wizard closed.')],
                    components: []
                });
                return;
            }

            if (id === 'setup_back') {
                session.step = Math.max(0, session.step - 1);
                setupSessions.set(interaction.user.id, session);
                await interaction.update({
                    embeds: [buildSetupEmbed(session.step, session.values)],
                    components: [buildSetupRow(session.step)]
                });
                return;
            }

            if (id.startsWith('setup_set_')) {
                const stepIndex = parseInt(id.replace('setup_set_', ''));
                const stepDef = SETUP_STEPS[stepIndex];
                const modal = new ModalBuilder()
                    .setCustomId(`setup_modal_${stepIndex}`)
                    .setTitle(`Set: ${stepDef.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('setup_value')
                                .setLabel(stepDef.label)
                                .setStyle(TextInputStyle.Short)
                                .setPlaceholder(stepDef.hint.substring(0, 100))
                                .setValue(session.values[stepDef.key] || '')
                                .setRequired(true)
                        )
                    );
                await interaction.showModal(modal);
                return;
            }
        }

        // ================================================================
        // LAWYER ACCEPT/DECLINE BUTTONS (DM buttons)
        // ================================================================
        if (id.startsWith('accept_lawyer_') || id.startsWith('decline_lawyer_')) {
            const parts = id.split('_');
            const action = parts[0]; // accept or decline
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
                await interaction.update({ embeds: [simpleEmbed(Colors.success, '✅ Accepted', `You are now the ${side} lawyer for **${formatCaseId(c.case_number)}**.`)], components: [] });
            } else {
                await pool.query(`UPDATE lawyer_requests SET status = 'DECLINED' WHERE id = $1`, [req.id]);
                await dmUser(req.requester_id, simpleEmbed(Colors.warn, '❌ Lawyer Request Declined', `<@${interaction.user.id}> declined your lawyer request for **${formatCaseId(c.case_number)}** (${side}).`));

                const guild = client.guilds.cache.get(c.guild_id);
                if (guild && c.case_channel_id) {
                    const ch = await guild.channels.fetch(c.case_channel_id).catch(() => null);
                    if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, '❌ Lawyer Request Declined', `<@${interaction.user.id}> has declined the lawyer request for the ${side}.`)] });
                }
                await interaction.update({ embeds: [simpleEmbed(Colors.neutral, '❌ Declined', `You declined the lawyer request for **${formatCaseId(c.case_number)}**.`)], components: [] });
            }
            return;
        }
    }

    // ---- MODAL SUBMISSIONS ----
    if (interaction.isModalSubmit()) {
        const id = interaction.customId;

        if (id.startsWith('setup_modal_')) {
            const stepIndex = parseInt(id.replace('setup_modal_', ''));
            const session = setupSessions.get(interaction.user.id);
            if (!session) return interaction.reply({ content: 'Session expired. Run `/setup` again.', ephemeral: true });

            const value = interaction.fields.getTextInputValue('setup_value').trim();
            const stepDef = SETUP_STEPS[stepIndex];
            session.values[stepDef.key] = value;

            const nextStep = stepIndex + 1;

            if (nextStep >= SETUP_STEPS.length) {
                // All steps done — save to DB
                const v = session.values;
                await pool.query(`
                    INSERT INTO guild_config (guild_id, court_category_id, archive_category_id, judge_chat_name, court_records_name, jury_chat_name, case_channel_format, archive_channel_format, judge_role_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                    ON CONFLICT (guild_id) DO UPDATE SET
                        court_category_id = $2, archive_category_id = $3, judge_chat_name = $4,
                        court_records_name = $5, jury_chat_name = $6, case_channel_format = $7,
                        archive_channel_format = $8, judge_role_id = $9
                `, [session.guildId, v.court_category_id, v.archive_category_id, v.judge_chat_name, v.court_records_name, v.jury_chat_name, v.case_channel_format, v.archive_channel_format, v.judge_role_id]);

                setupSessions.delete(interaction.user.id);
                await interaction.update({
                    embeds: [simpleEmbed(Colors.success, '✅ Setup Complete', 'Court bot is fully configured and ready!')],
                    components: []
                });
            } else {
                session.step = nextStep;
                setupSessions.set(interaction.user.id, session);
                await interaction.update({
                    embeds: [buildSetupEmbed(nextStep, session.values)],
                    components: [buildSetupRow(nextStep)]
                });
            }
            return;
        }
    }
});

// ============================================================
// --- ASSIGN LAWYER HELPER ---
// ============================================================

async function _assignLawyer(c, req, userId, guild) {
    const field = req.side === 'prosecution' ? 'prosecutor_lawyer_id' : 'defense_lawyer_id';
    await pool.query(`UPDATE cases SET ${field} = $1 WHERE id = $2`, [userId, c.id]);

    const updated = await getCaseById(c.id);

    // Check if both lawyers now assigned — update status
    if (updated.prosecutor_lawyer_id && updated.defense_lawyer_id && updated.judge_id && updated.status === 'WAITING_LAWYERS') {
        await pool.query(`UPDATE cases SET status = 'ASSIGNED' WHERE id = $1`, [updated.id]);
    }

    const final = await getCaseById(c.id);

    // Give lawyer access to case channel
    if (final.case_channel_id) {
        const ch = await guild.channels.fetch(final.case_channel_id).catch(() => null);
        if (ch) await addParticipantToChannel(ch, userId);
    }

    await updatePinnedEmbed(final);

    // Notify all participants
    const participants = await getCaseParticipants(final);
    await dmAll(participants, simpleEmbed(Colors.success, '👤 Lawyer Assigned', `<@${userId}> is now the ${req.side} lawyer for **${formatCaseId(final.case_number)}**.`));
}

// ============================================================
// --- MESSAGE HANDLER (Evidence Logging) ---
// ============================================================

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    // Check if this message is in an active case channel
    const { rows } = await pool.query(
        `SELECT * FROM cases WHERE guild_id = $1 AND case_channel_id = $2 AND status NOT IN ('CLOSED','CANCELLED','DISMISSED')`,
        [message.guild.id, message.channel.id]
    );
    const c = rows[0];
    if (!c) return;

    // Only log messages from participants (not spectators)
    const participantIds = [
        c.prosecutor_id, c.defendant_id,
        c.judge_id, c.prosecutor_lawyer_id, c.defense_lawyer_id
    ].filter(Boolean);

    const jury = await getJuryMembers(c.id);
    jury.forEach(j => participantIds.push(j.user_id));

    if (!participantIds.includes(message.author.id)) return;

    // Log as evidence
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
