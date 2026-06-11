'use strict';

// ============================================================
// commands.js - Court Bot Part 2
// Lawyer, jury, evidence, info/stats, and admin override commands.
// All commands here are routed from index.js via registerCommands2().
// ============================================================

const {
    EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder,
    PermissionFlagsBits, ChannelType
} = require('discord.js');
const { pool } = require('./index.js');
const {
    Colors, STATUS_COLORS, MAX_JURY,
    simpleEmbed, infoEmbed, errEmbed, ts,
    parseDuration, msToHuman, parseIds, formatCaseId,
    paginatedReply, confirm,
    getConfig, ensureConfig, resolveChannelName,
    getActiveCases, getCaseById, getCaseByNumber,
    getJuryMembers, resolveCase,
    isJudgeOnActiveCase, isLawyerOnActiveCase, isJurorOnActiveCase,
    updatePinnedEmbed, buildCaseEmbed,
    dmUser, dmAll, getCaseParticipants,
    addParticipantToChannel, removeParticipantFromChannel, lockChannel,
    archiveCase, buildSummaryEmbed,
    scheduleCase, activeTimers,
    _assignLawyer, logAction,
    jailUser, unjailUser,
    client,
} = require('./index.js');

// ============================================================
// --- MAIN ROUTER ---
// Called from index.js interactionCreate for commands not
// handled there. Returns true if the command was handled.
// ============================================================

async function registerCommands2(interaction, cmd, guildId, isAdmin) {

    // ================================================================
    // /transfercase
    // ================================================================
    if (cmd === 'transfercase') {
        if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] }), true;
        const caseInput = interaction.options.getString('case_id');
        const newJudgeUser = interaction.options.getUser('new_judge');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (['CLOSED','CANCELLED','DISMISSED'].includes(c.status))
            return interaction.editReply({ embeds: [errEmbed('Cannot transfer a closed case.')] }), true;

        const config = await getConfig(guildId);
        if (config?.judge_role_id) {
            const newMember = await interaction.guild.members.fetch(newJudgeUser.id).catch(() => null);
            if (newMember && !newMember.roles.cache.has(config.judge_role_id))
                return interaction.editReply({ embeds: [errEmbed('<@' + newJudgeUser.id + '> does not have the Judge role.')] }), true;
        }

        if (await isJudgeOnActiveCase(guildId, newJudgeUser.id))
            return interaction.editReply({ embeds: [errEmbed('<@' + newJudgeUser.id + '> is already the judge on another active case.')] }), true;

        const oldJudgeId = c.judge_id;
        await pool.query('UPDATE cases SET judge_id = $1 WHERE id = $2', [newJudgeUser.id, c.id]);
        const updated = await getCaseById(c.id);

        const guild = interaction.guild;

        // Add new judge to channels, remove old judge
        if (updated.case_channel_id) {
            const ch = await guild.channels.fetch(updated.case_channel_id).catch(() => null);
            if (ch) {
                await addParticipantToChannel(ch, newJudgeUser.id);
                if (oldJudgeId) await removeParticipantFromChannel(ch, oldJudgeId);
            }
        }
        if (updated.judge_chat_channel_id) {
            const jch = await guild.channels.fetch(updated.judge_chat_channel_id).catch(() => null);
            if (jch) {
                await addParticipantToChannel(jch, newJudgeUser.id);
                if (oldJudgeId) await removeParticipantFromChannel(jch, oldJudgeId);
            }
        }
        if (updated.jury_chat_channel_id) {
            const jrch = await guild.channels.fetch(updated.jury_chat_channel_id).catch(() => null);
            if (jrch) {
                await addParticipantToChannel(jrch, newJudgeUser.id);
                if (oldJudgeId) await removeParticipantFromChannel(jrch, oldJudgeId);
            }
        }

        await updatePinnedEmbed(updated);

        const participants = await getCaseParticipants(updated);
        await dmAll(participants, simpleEmbed(Colors.info, 'Judge Transferred', `**${formatCaseId(c.case_number)}** has been transferred from ${oldJudgeId ? `<@${oldJudgeId}>` : '*none*'} to <@${newJudgeUser.id}>.`));

        await logAction(newJudgeUser.id, 'JUDGE_TRANSFERRED', formatCaseId(c.case_number), interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Transferred', `**${formatCaseId(c.case_number)}** is now under judge <@${newJudgeUser.id}>.`)] }), true;
    }

    // ================================================================
    // /forcestart
    // ================================================================
    if (cmd === 'forcestart') {
        if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] }), true;
        const caseInput = interaction.options.getString('case_id');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (['CLOSED','CANCELLED','DISMISSED','IN_PROGRESS'].includes(c.status))
            return interaction.editReply({ embeds: [errEmbed(`Cannot force-start a case with status: ${c.status}.`)] }), true;

        // Clear any existing scheduled timer
        if (activeTimers.has(`case_${c.id}`)) {
            clearTimeout(activeTimers.get(`case_${c.id}`));
            activeTimers.delete(`case_${c.id}`);
        }

        await pool.query(`UPDATE cases SET status = 'IN_PROGRESS', started_at = NOW() WHERE id = $1`, [c.id]);
        const updated = await getCaseById(c.id);

        if (updated.case_channel_id) {
            const ch = await client.channels.fetch(updated.case_channel_id).catch(() => null);
            if (ch) {
                await ch.send({ embeds: [simpleEmbed(Colors.in_progress, 'Court is Now in Session (Force Started)', `${formatCaseId(updated.case_number)} has been force-started by an admin. All parties, please take your positions.`)] });
            }
        }

        await updatePinnedEmbed(updated);

        const participants = await getCaseParticipants(updated);
        await dmAll(participants, simpleEmbed(Colors.in_progress, 'Court is Now in Session', `${formatCaseId(updated.case_number)} has been force-started.`));

        await logAction(guildId, 'CASE_FORCE_STARTED', formatCaseId(updated.case_number), interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Force Started', `**${formatCaseId(c.case_number)}** is now IN_PROGRESS.`)] }), true;
    }

    // ================================================================
    // /setstatus
    // ================================================================
    if (cmd === 'setstatus') {
        if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] }), true;
        const caseInput = interaction.options.getString('case_id');
        const newStatus = interaction.options.getString('status');

        const c = await resolveCase(guildId, caseInput);
        if (!c) {
            // Also check closed cases
            const numMatch = caseInput.match(/(\d+)/);
            if (!numMatch) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
            const cc = await getCaseByNumber(guildId, parseInt(numMatch[1]));
            if (!cc) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

            await pool.query('UPDATE cases SET status = $1 WHERE id = $2', [newStatus, cc.id]);
            const updated = await getCaseById(cc.id);
            await updatePinnedEmbed(updated);
            await logAction(interaction.user.id, 'STATUS_OVERRIDE', `${formatCaseId(cc.case_number)} -> ${newStatus}`, interaction.user.id);
            return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Status Updated', `**${formatCaseId(cc.case_number)}** status set to \`${newStatus}\`.`)] }), true;
        }

        await pool.query('UPDATE cases SET status = $1 WHERE id = $2', [newStatus, c.id]);
        const updated = await getCaseById(c.id);
        await updatePinnedEmbed(updated);
        await logAction(interaction.user.id, 'STATUS_OVERRIDE', `${formatCaseId(c.case_number)} -> ${newStatus}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Status Updated', `**${formatCaseId(c.case_number)}** status set to \`${newStatus}\`.`)] }), true;
    }

    // ================================================================
    // /editcase
    // ================================================================
    if (cmd === 'editcase') {
        if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] }), true;
        const caseInput = interaction.options.getString('case_id');
        const field = interaction.options.getString('field');
        const value = interaction.options.getString('value');

        const ALLOWED_FIELDS = ['reason', 'verdict_reason', 'punishment_type', 'punishment_length'];
        if (!ALLOWED_FIELDS.includes(field))
            return interaction.editReply({ embeds: [errEmbed(`Invalid field. Allowed: ${ALLOWED_FIELDS.join(', ')}.`)] }), true;

        const numMatch = caseInput.match(/(\d+)/);
        const c = numMatch ? await getCaseByNumber(guildId, parseInt(numMatch[1])) : null;
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        // Sanitize punishment_type value
        if (field === 'punishment_type') {
            const validTypes = ['MUTE', 'BAN', 'KICK', 'JAIL'];
            if (!validTypes.includes(value.toUpperCase()))
                return interaction.editReply({ embeds: [errEmbed(`Invalid punishment type. Allowed: ${validTypes.join(', ')}.`)] }), true;
        }

        await pool.query(`UPDATE cases SET ${field} = $1 WHERE id = $2`, [value, c.id]);
        const updated = await getCaseById(c.id);
        await updatePinnedEmbed(updated);

        await logAction(interaction.user.id, 'CASE_EDITED', `${formatCaseId(c.case_number)}.${field} = ${value}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Case Edited', `**${formatCaseId(c.case_number)}** field \`${field}\` updated to: ${value}`)] }), true;
    }

    // ================================================================
    // /requestlawyer
    // ================================================================
    if (cmd === 'requestlawyer') {
        const caseInput = interaction.options.getString('case_id');
        const targetUser = interaction.options.getUser('user');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const isProsecutor = c.prosecutor_id === interaction.user.id;
        const isDefendant  = c.defendant_id  === interaction.user.id;
        if (!isProsecutor && !isDefendant)
            return interaction.editReply({ embeds: [errEmbed('Only the prosecutor or defendant can request a lawyer.')] }), true;

        const side = isProsecutor ? 'prosecution' : 'defense';
        const alreadyHas = isProsecutor ? c.prosecutor_lawyer_id : c.defense_lawyer_id;
        if (alreadyHas) return interaction.editReply({ embeds: [errEmbed('You already have a lawyer assigned.')] }), true;

        if (targetUser.id === c.prosecutor_id || targetUser.id === c.defendant_id)
            return interaction.editReply({ embeds: [errEmbed('A case participant cannot be a lawyer.')] }), true;
        if (targetUser.bot)
            return interaction.editReply({ embeds: [errEmbed('A bot cannot be a lawyer.')] }), true;

        if (await isLawyerOnActiveCase(guildId, targetUser.id))
            return interaction.editReply({ embeds: [errEmbed(`<@${targetUser.id}> is already a lawyer on another active case.`)] }), true;

        const { rows: existingReq } = await pool.query(
            `SELECT * FROM lawyer_requests WHERE case_id = $1 AND side = $2 AND status = 'PENDING'`,
            [c.id, side]
        );
        if (existingReq.length)
            return interaction.editReply({ embeds: [errEmbed('There is already a pending lawyer request for this side.')] }), true;

        await pool.query(
            `INSERT INTO lawyer_requests (case_id, requester_id, requested_id, side) VALUES ($1, $2, $3, $4)`,
            [c.id, interaction.user.id, targetUser.id, side]
        );

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) {
                await ch.send({ embeds: [simpleEmbed(Colors.info, 'Lawyer Requested', `<@${interaction.user.id}> has requested <@${targetUser.id}> as their lawyer (${side}).\nAwaiting response.`)] });
            }
        }

        const dmEmbed = simpleEmbed(Colors.info, 'Lawyer Request', `<@${interaction.user.id}> is requesting you to be their lawyer for the **${side}** in **${formatCaseId(c.case_number)}** in **${interaction.guild.name}**.\n\nUse \`/acceptlawyer ${c.case_number}\` to accept or \`/declinelawyer ${c.case_number}\` to decline.`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_lawyer_${c.id}_${side}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_lawyer_${c.id}_${side}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
        );
        try {
            const dmChannel = await targetUser.createDM();
            await dmChannel.send({ embeds: [dmEmbed], components: [row] });
        } catch { /* DMs closed */ }

        await logAction(targetUser.id, 'LAWYER_REQUESTED', `${side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Lawyer Requested', `Request sent to <@${targetUser.id}>.`)] }), true;
    }

    // ================================================================
    // /revokelawyer
    // ================================================================
    if (cmd === 'revokelawyer') {
        const caseInput = interaction.options.getString('case_id');
        const reason = interaction.options.getString('reason');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const isProsecutor = c.prosecutor_id === interaction.user.id;
        const isDefendant  = c.defendant_id  === interaction.user.id;
        if (!isProsecutor && !isDefendant && !isAdmin)
            return interaction.editReply({ embeds: [errEmbed('Only the prosecutor, defendant, or an admin can revoke a lawyer.')] }), true;

        // Determine which side to revoke (admins can pick by checking both)
        let lawyerId, field;
        if (isProsecutor || (isAdmin && c.prosecutor_lawyer_id && !c.defense_lawyer_id)) {
            lawyerId = c.prosecutor_lawyer_id;
            field = 'prosecutor_lawyer_id';
        } else if (isDefendant || (isAdmin && c.defense_lawyer_id)) {
            lawyerId = c.defense_lawyer_id;
            field = 'defense_lawyer_id';
        }

        if (!lawyerId) return interaction.editReply({ embeds: [errEmbed('No lawyer found to revoke on your side.')] }), true;

        await pool.query(`UPDATE cases SET ${field} = NULL WHERE id = $1`, [c.id]);

        const updated = await getCaseById(c.id);
        if (['SCHEDULED', 'ASSIGNED'].includes(updated.status)) {
            await pool.query(`UPDATE cases SET status = 'WAITING_LAWYERS' WHERE id = $1`, [c.id]);
            if (activeTimers.has(`case_${c.id}`)) {
                clearTimeout(activeTimers.get(`case_${c.id}`));
                activeTimers.delete(`case_${c.id}`);
            }
        }
        const final = await getCaseById(c.id);
        await updatePinnedEmbed(final);

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) await removeParticipantFromChannel(ch, lawyerId);
        }

        await dmUser(lawyerId, simpleEmbed(Colors.warn, 'Lawyer Revoked', `You have been removed as a lawyer from **${formatCaseId(c.case_number)}**.\n**Reason:** ${reason}`));

        await logAction(lawyerId, 'LAWYER_REVOKED', reason, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Lawyer Revoked', `<@${lawyerId}> has been removed.`)] }), true;
    }

    // ================================================================
    // /acceptlawyer
    // ================================================================
    if (cmd === 'acceptlawyer') {
        const caseInput = interaction.options.getString('case_id');
        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const { rows: reqRows } = await pool.query(
            `SELECT * FROM lawyer_requests WHERE case_id = $1 AND requested_id = $2 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
            [c.id, interaction.user.id]
        );
        if (!reqRows.length) return interaction.editReply({ embeds: [errEmbed('No pending lawyer request for you on this case.')] }), true;
        const req = reqRows[0];

        if (await isLawyerOnActiveCase(guildId, interaction.user.id))
            return interaction.editReply({ embeds: [errEmbed('You are already a lawyer on another active case.')] }), true;

        await _assignLawyer(c, req, interaction.user.id, interaction.guild);
        await pool.query(`UPDATE lawyer_requests SET status = 'ACCEPTED' WHERE id = $1`, [req.id]);

        await logAction(interaction.user.id, 'LAWYER_ACCEPTED', `${req.side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Lawyer Accepted', `You are now the ${req.side} lawyer for **${formatCaseId(c.case_number)}**.`)] }), true;
    }

    // ================================================================
    // /declinelawyer
    // ================================================================
    if (cmd === 'declinelawyer') {
        const caseInput = interaction.options.getString('case_id');
        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const { rows: reqRows } = await pool.query(
            `SELECT * FROM lawyer_requests WHERE case_id = $1 AND requested_id = $2 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
            [c.id, interaction.user.id]
        );
        if (!reqRows.length) return interaction.editReply({ embeds: [errEmbed('No pending lawyer request for you on this case.')] }), true;
        const req = reqRows[0];

        await pool.query(`UPDATE lawyer_requests SET status = 'DECLINED' WHERE id = $1`, [req.id]);
        await dmUser(req.requester_id, simpleEmbed(Colors.warn, 'Lawyer Request Declined', `<@${interaction.user.id}> has declined your lawyer request for **${formatCaseId(c.case_number)}** (${req.side}).`));

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, 'Lawyer Request Declined', `<@${interaction.user.id}> has declined the lawyer request for the ${req.side}.`)] });
        }

        await logAction(interaction.user.id, 'LAWYER_DECLINED', `${req.side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Request Declined', `You have declined the lawyer request for **${formatCaseId(c.case_number)}**.`)] }), true;
    }

    // ================================================================
    // /replacelawyer
    // ================================================================
    if (cmd === 'replacelawyer') {
        if (!isAdmin) return interaction.editReply({ embeds: [errEmbed('Administrator permission required.')] }), true;
        const caseInput = interaction.options.getString('case_id');
        const side = interaction.options.getString('side');
        const newLawyerUser = interaction.options.getUser('user');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (['CLOSED','CANCELLED','DISMISSED'].includes(c.status))
            return interaction.editReply({ embeds: [errEmbed('Cannot modify a closed case.')] }), true;

        if (newLawyerUser.id === c.prosecutor_id || newLawyerUser.id === c.defendant_id)
            return interaction.editReply({ embeds: [errEmbed('A case participant cannot be a lawyer.')] }), true;

        if (await isLawyerOnActiveCase(guildId, newLawyerUser.id))
            return interaction.editReply({ embeds: [errEmbed(`<@${newLawyerUser.id}> is already a lawyer on another active case.`)] }), true;

        const field = side === 'prosecution' ? 'prosecutor_lawyer_id' : 'defense_lawyer_id';
        const oldLawyerId = side === 'prosecution' ? c.prosecutor_lawyer_id : c.defense_lawyer_id;

        await pool.query(`UPDATE cases SET ${field} = $1 WHERE id = $2`, [newLawyerUser.id, c.id]);
        const updated = await getCaseById(c.id);

        const guild = interaction.guild;

        // Remove old lawyer from channel, add new one
        if (c.case_channel_id) {
            const ch = await guild.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) {
                if (oldLawyerId) await removeParticipantFromChannel(ch, oldLawyerId);
                await addParticipantToChannel(ch, newLawyerUser.id);
            }
        }

        // Check if both lawyers now assigned
        if (updated.prosecutor_lawyer_id && updated.defense_lawyer_id && updated.judge_id && updated.status === 'WAITING_LAWYERS') {
            await pool.query(`UPDATE cases SET status = 'ASSIGNED' WHERE id = $1`, [updated.id]);
        }

        const final = await getCaseById(c.id);
        await updatePinnedEmbed(final);

        if (oldLawyerId) {
            await dmUser(oldLawyerId, simpleEmbed(Colors.warn, 'Lawyer Replaced', `You have been replaced as the ${side} lawyer in **${formatCaseId(c.case_number)}**.`));
        }
        await dmUser(newLawyerUser.id, simpleEmbed(Colors.info, 'Lawyer Assigned', `You have been assigned as the ${side} lawyer in **${formatCaseId(c.case_number)}** by an admin.`));

        const participants = await getCaseParticipants(final);
        await dmAll(participants, simpleEmbed(Colors.info, 'Lawyer Replaced', `The ${side} lawyer for **${formatCaseId(c.case_number)}** is now <@${newLawyerUser.id}>.`));

        await logAction(newLawyerUser.id, 'LAWYER_REPLACED', `${side} for ${formatCaseId(c.case_number)}`, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Lawyer Replaced', `<@${newLawyerUser.id}> is now the ${side} lawyer for **${formatCaseId(c.case_number)}**.`)] }), true;
    }

    // ================================================================
    // /joinjury
    // ================================================================
    if (cmd === 'joinjury') {
        const caseInput = interaction.options.getString('case_id');
        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (!['FILED','ASSIGNED','WAITING_LAWYERS','SCHEDULED'].includes(c.status))
            return interaction.editReply({ embeds: [errEmbed('Jury can only join before the case starts.')] }), true;

        const userId = interaction.user.id;
        if ([c.prosecutor_id, c.defendant_id, c.judge_id, c.prosecutor_lawyer_id, c.defense_lawyer_id].includes(userId))
            return interaction.editReply({ embeds: [errEmbed('Case participants cannot join the jury.')] }), true;

        if (await isJurorOnActiveCase(guildId, userId))
            return interaction.editReply({ embeds: [errEmbed('You are already a juror on another active case.')] }), true;

        const jury = await getJuryMembers(c.id);
        if (jury.length >= MAX_JURY)
            return interaction.editReply({ embeds: [errEmbed(`The jury is full (max ${MAX_JURY}).`)] }), true;
        if (jury.some(j => j.user_id === userId))
            return interaction.editReply({ embeds: [errEmbed('You are already on the jury.')] }), true;

        await pool.query('INSERT INTO jury_members (case_id, user_id) VALUES ($1, $2)', [c.id, userId]);

        if (c.jury_chat_channel_id) {
            const jch = await client.channels.fetch(c.jury_chat_channel_id).catch(() => null);
            if (jch) await addParticipantToChannel(jch, userId);
        }

        const updated = await getCaseById(c.id);
        await updatePinnedEmbed(updated);

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) await ch.send({ embeds: [simpleEmbed(Colors.success, 'Jury Member Joined', `<@${userId}> has joined the jury for **${formatCaseId(c.case_number)}**. (${jury.length + 1}/${MAX_JURY})`)] });
        }

        await logAction(userId, 'JURY_JOINED', formatCaseId(c.case_number), userId);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Joined Jury', `You are now on the jury for **${formatCaseId(c.case_number)}**.`)] }), true;
    }

    // ================================================================
    // /kickjuror
    // ================================================================
    if (cmd === 'kickjuror') {
        const caseInput = interaction.options.getString('case_id');
        const targetUser = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (c.judge_id !== interaction.user.id && !isAdmin)
            return interaction.editReply({ embeds: [errEmbed('Only the presiding judge or an admin can kick a juror.')] }), true;

        const jury = await getJuryMembers(c.id);
        const jurorRecord = jury.find(j => j.user_id === targetUser.id);
        if (!jurorRecord) return interaction.editReply({ embeds: [errEmbed('<@' + targetUser.id + '> is not on the jury for this case.')] }), true;

        await pool.query('DELETE FROM jury_members WHERE id = $1', [jurorRecord.id]);

        // Remove from jury-chat
        if (c.jury_chat_channel_id) {
            const jch = await client.channels.fetch(c.jury_chat_channel_id).catch(() => null);
            if (jch) await removeParticipantFromChannel(jch, targetUser.id);
        }

        const updated = await getCaseById(c.id);
        await updatePinnedEmbed(updated);

        await dmUser(targetUser.id, simpleEmbed(Colors.warn, 'Removed from Jury', `You have been removed from the jury for **${formatCaseId(c.case_number)}**.\n**Reason:** ${reason}`));

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, 'Juror Removed', `<@${targetUser.id}> has been removed from the jury.\n**Reason:** ${reason}`)] });
        }

        await logAction(targetUser.id, 'JUROR_KICKED', reason, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Juror Removed', `<@${targetUser.id}> has been removed from the jury.`)] }), true;
    }

    // ================================================================
    // /vote
    // ================================================================
    if (cmd === 'vote') {
        const caseInput = interaction.options.getString('case_id');
        const voteValue = interaction.options.getString('vote');
        const voteReason = interaction.options.getString('reason');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (c.status !== 'IN_PROGRESS')
            return interaction.editReply({ embeds: [errEmbed('Voting is only allowed during IN_PROGRESS.')] }), true;

        const jury = await getJuryMembers(c.id);
        const member = jury.find(j => j.user_id === interaction.user.id);
        if (!member) return interaction.editReply({ embeds: [errEmbed('You are not on the jury for this case.')] }), true;
        if (member.vote) return interaction.editReply({ embeds: [errEmbed('You have already voted.')] }), true;

        await pool.query(
            `UPDATE jury_members SET vote = $1, vote_reason = $2, voted_at = NOW() WHERE id = $3`,
            [voteValue, voteReason, member.id]
        );

        if (c.jury_chat_channel_id) {
            const jch = await client.channels.fetch(c.jury_chat_channel_id).catch(() => null);
            if (jch) await jch.send({ embeds: [simpleEmbed(Colors.info, 'Vote Cast', `<@${interaction.user.id}> has cast their vote.`)] });
        }

        await logAction(interaction.user.id, `JURY_VOTE_${voteValue}`, formatCaseId(c.case_number), interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Vote Cast', 'Your vote has been recorded.')] }), true;
    }

    // ================================================================
    // /jurytally
    // ================================================================
    if (cmd === 'jurytally') {
        const caseInput = interaction.options.getString('case_id');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (c.judge_id !== interaction.user.id && !isAdmin)
            return interaction.editReply({ embeds: [errEmbed('Only the presiding judge or an admin can view the tally.')] }), true;

        const jury = await getJuryMembers(c.id);
        const guilty    = jury.filter(j => j.vote === 'GUILTY').length;
        const notGuilty = jury.filter(j => j.vote === 'NOT GUILTY').length;
        const pending   = jury.filter(j => !j.vote).length;

        const lines = [
            `**Case:** ${formatCaseId(c.case_number)}`,
            `**Total Jurors:** ${jury.length}`,
            '',
            `- **Guilty:** ${guilty}`,
            `- **Not Guilty:** ${notGuilty}`,
            `- **Pending:** ${pending}`,
        ];

        if (jury.length) {
            lines.push('');
            lines.push('**Individual Votes:**');
            for (const j of jury) {
                lines.push(`<@${j.user_id}>: ${j.vote ? `\`${j.vote}\`` : '*Not yet voted*'}${j.vote_reason ? ` - ${j.vote_reason}` : ''}`);
            }
        }

        return interaction.editReply({ embeds: [infoEmbed(Colors.info, 'Jury Tally', lines)] }), true;
    }

    // ================================================================
    // /strikeevidence
    // ================================================================
    if (cmd === 'strikeevidence') {
        const caseInput = interaction.options.getString('case_id');
        const messageId = interaction.options.getString('message_id');
        const reason    = interaction.options.getString('reason');

        const c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;
        if (c.judge_id !== interaction.user.id && !isAdmin)
            return interaction.editReply({ embeds: [errEmbed('Only the presiding judge or an admin can strike evidence.')] }), true;

        const { rows: evRows } = await pool.query(
            `SELECT * FROM evidence WHERE case_id = $1 AND message_id = $2`,
            [c.id, messageId]
        );
        if (!evRows.length) return interaction.editReply({ embeds: [errEmbed('Message not found in evidence log.')] }), true;
        if (evRows[0].struck) return interaction.editReply({ embeds: [errEmbed('This evidence has already been struck.')] }), true;

        await pool.query(
            `UPDATE evidence SET struck = TRUE, struck_by = $1, struck_reason = $2 WHERE message_id = $3 AND case_id = $4`,
            [interaction.user.id, reason, messageId, c.id]
        );
        await pool.query(`UPDATE cases SET evidence_count = evidence_count - 1 WHERE id = $1`, [c.id]);

        const updated = await getCaseById(c.id);
        await updatePinnedEmbed(updated);

        if (c.case_channel_id) {
            const ch = await client.channels.fetch(c.case_channel_id).catch(() => null);
            if (ch) await ch.send({ embeds: [simpleEmbed(Colors.warn, 'Evidence Struck', `Message \`${messageId}\` has been struck from the evidence log.\n**Reason:** ${reason}\n**By:** <@${interaction.user.id}>`)] });
        }

        await logAction(interaction.user.id, 'EVIDENCE_STRUCK', reason, interaction.user.id);
        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Evidence Struck', `Message \`${messageId}\` removed from evidence log.`)] }), true;
    }

    // ================================================================
    // /evidence
    // ================================================================
    if (cmd === 'evidence') {
        const caseInput = interaction.options.getString('case_id');
        const numMatch = caseInput.match(/(\d+)/);
        let c = numMatch ? await getCaseByNumber(guildId, parseInt(numMatch[1])) : null;
        if (!c) c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const { rows: evRows } = await pool.query(
            `SELECT * FROM evidence WHERE case_id = $1 ORDER BY created_at ASC`,
            [c.id]
        );

        if (!evRows.length)
            return interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, 'Evidence Log', `No evidence logged for **${formatCaseId(c.case_number)}**.`)] }), true;

        await paginatedReply(
            interaction, evRows, 8,
            STATUS_COLORS[c.status] || Colors.neutral,
            `Evidence Log - ${formatCaseId(c.case_number)}`,
            (ev) => {
                const struckLabel = ev.struck ? ' [STRUCK]' : '';
                const struckBy = ev.struck ? `\n*Struck by <@${ev.struck_by}> - ${ev.struck_reason}*` : '';
                return `**Msg ID:** \`${ev.message_id}\`${struckLabel}\n**Author:** <@${ev.author_id}>\n**Content:** ${ev.content?.substring(0, 120) || '*empty*'}${struckBy}\n*${ts(ev.created_at)}*`;
            }
        );
        return true;
    }

    // ================================================================
    // /exportcase
    // ================================================================
    if (cmd === 'exportcase') {
        const caseInput = interaction.options.getString('case_id');
        const numMatch = caseInput.match(/(\d+)/);
        let c = numMatch ? await getCaseByNumber(guildId, parseInt(numMatch[1])) : null;
        if (!c) c = await resolveCase(guildId, caseInput);
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        // Must be judge, admin, or case participant
        const participants = await getCaseParticipants(c);
        if (!participants.includes(interaction.user.id) && !isAdmin)
            return interaction.editReply({ embeds: [errEmbed('You must be a participant or admin to export this case.')] }), true;

        const jury = await getJuryMembers(c.id);
        const { rows: evRows } = await pool.query(
            `SELECT * FROM evidence WHERE case_id = $1 ORDER BY created_at ASC`,
            [c.id]
        );
        const { rows: lawyerReqs } = await pool.query(
            `SELECT * FROM lawyer_requests WHERE case_id = $1 ORDER BY created_at ASC`,
            [c.id]
        );

        const lines = [
            '='.repeat(60),
            `COURT BOT - CASE TRANSCRIPT`,
            `Exported: ${new Date().toUTCString()}`,
            '='.repeat(60),
            '',
            `Case ID:              ${formatCaseId(c.case_number)}`,
            `Status:               ${c.status}`,
            `Filed:                ${new Date(c.filed_at).toUTCString()}`,
            `Reason:               ${c.reason}`,
            '',
            `Prosecutor:           ${c.prosecutor_id}`,
            `Prosecutor's Lawyer:  ${c.prosecutor_lawyer_id || 'None'}`,
            `Defendant:            ${c.defendant_id}`,
            `Defense Lawyer:       ${c.defense_lawyer_id || 'None'}`,
            `Judge:                ${c.judge_id || 'None'}`,
            '',
            `Scheduled:            ${c.scheduled_at ? new Date(c.scheduled_at).toUTCString() : 'N/A'}`,
            `Started:              ${c.started_at ? new Date(c.started_at).toUTCString() : 'N/A'}`,
            `Closed:               ${c.closed_at ? new Date(c.closed_at).toUTCString() : 'N/A'}`,
            '',
            `Verdict:              ${c.verdict || 'None'}`,
            `Verdict Reason:       ${c.verdict_reason || 'N/A'}`,
            `Punishment Type:      ${c.punishment_type || 'None'}`,
            `Punishment Length:    ${c.punishment_length || 'N/A'}`,
            '',
            '-'.repeat(60),
            'JURY MEMBERS',
            '-'.repeat(60),
        ];

        if (jury.length) {
            for (const j of jury) {
                lines.push(`User: ${j.user_id} | Vote: ${j.vote || 'Not voted'} | Reason: ${j.vote_reason || 'N/A'}`);
            }
        } else {
            lines.push('No jury members.');
        }

        lines.push('');
        lines.push('-'.repeat(60));
        lines.push('EVIDENCE LOG');
        lines.push('-'.repeat(60));

        if (evRows.length) {
            for (const ev of evRows) {
                const struck = ev.struck ? '[STRUCK] ' : '';
                lines.push(`${struck}[${new Date(ev.created_at).toUTCString()}] Author: ${ev.author_id}`);
                lines.push(`  Msg ID: ${ev.message_id}`);
                lines.push(`  Content: ${ev.content || '*empty*'}`);
                if (ev.struck) lines.push(`  Struck by: ${ev.struck_by} - Reason: ${ev.struck_reason}`);
                lines.push('');
            }
        } else {
            lines.push('No evidence logged.');
        }

        lines.push('-'.repeat(60));
        lines.push('LAWYER REQUESTS');
        lines.push('-'.repeat(60));

        if (lawyerReqs.length) {
            for (const lr of lawyerReqs) {
                lines.push(`[${new Date(lr.created_at).toUTCString()}] ${lr.side} - Requester: ${lr.requester_id} -> Requested: ${lr.requested_id} | Status: ${lr.status}`);
            }
        } else {
            lines.push('No lawyer requests.');
        }

        lines.push('');
        lines.push('='.repeat(60));
        lines.push('END OF TRANSCRIPT');

        const transcript = lines.join('\n');

        // Send as a DM file attachment
        const fileName = `case-${formatCaseId(c.case_number)}-transcript.txt`;
        const buffer = Buffer.from(transcript, 'utf-8');

        try {
            const user = await client.users.fetch(interaction.user.id);
            await user.send({
                embeds: [simpleEmbed(Colors.info, 'Case Transcript', `Transcript for **${formatCaseId(c.case_number)}** attached below.`)],
                files: [{ attachment: buffer, name: fileName }],
            });
        } catch {
            return interaction.editReply({ embeds: [errEmbed('Could not DM you the transcript. Please enable DMs.')] }), true;
        }

        return interaction.editReply({ embeds: [simpleEmbed(Colors.success, 'Transcript Sent', `The transcript for **${formatCaseId(c.case_number)}** has been DMed to you.`)] }), true;
    }

    // ================================================================
    // /caseinfo
    // ================================================================
    if (cmd === 'caseinfo') {
        const caseInput = interaction.options.getString('case_id');
        let c = await resolveCase(guildId, caseInput);
        if (!c) {
            const numMatch = caseInput.match(/(\d+)/);
            if (numMatch) c = await getCaseByNumber(guildId, parseInt(numMatch[1]));
        }
        if (!c) return interaction.editReply({ embeds: [errEmbed('Case not found.')] }), true;

        const jury = await getJuryMembers(c.id);
        const juryList = jury.length
            ? jury.map(j => `<@${j.user_id}>${j.vote ? ` (\`${j.vote}\`)` : ''}`).join(', ')
            : 'No jury';

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
            if (c.punishment_type) lines.push(`**Punishment:** \`${c.punishment_type}\` - ${c.punishment_length || 'permanent'}`);
        }
        if (c.case_channel_id) lines.push(`**Channel:** <#${c.case_channel_id}>`);
        if (c.closed_at) lines.push(`**Closed:** ${ts(c.closed_at)}`);

        const color = STATUS_COLORS[c.status] || Colors.neutral;
        return interaction.editReply({ embeds: [infoEmbed(color, `Case ${formatCaseId(c.case_number)}`, lines)] }), true;
    }

    // ================================================================
    // /listcases
    // ================================================================
    if (cmd === 'listcases') {
        const activeCases = await getActiveCases(guildId);
        if (!activeCases.length)
            return interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, 'Active Cases', 'No active cases right now.')] }), true;

        await paginatedReply(
            interaction, activeCases, 5, Colors.info,
            'Active Cases',
            (c) => {
                const lines = [
                    `**${formatCaseId(c.case_number)}** - \`${c.status}\``,
                    `Prosecutor: <@${c.prosecutor_id}> vs Defendant: <@${c.defendant_id}>`,
                    `Judge: ${c.judge_id ? `<@${c.judge_id}>` : '*Unassigned*'}`,
                    `Filed: ${ts(c.filed_at)}`,
                    c.case_channel_id ? `Channel: <#${c.case_channel_id}>` : '',
                ].filter(Boolean);
                return lines.join('\n');
            }
        );
        return true;
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
        const { rows: juryRows } = await pool.query(
            `SELECT c.* FROM cases c JOIN jury_members j ON j.case_id = c.id WHERE c.guild_id = $1 AND j.user_id = $2`,
            [guildId, user.id]
        );
        const allIds = new Set(rows.map(r => r.id));
        const combined = [...rows];
        for (const r of juryRows) if (!allIds.has(r.id)) combined.push(r);
        combined.sort((a, b) => new Date(b.filed_at) - new Date(a.filed_at));

        if (!combined.length)
            return interaction.editReply({ embeds: [simpleEmbed(Colors.neutral, 'Case History', `No cases found for <@${user.id}>.`)] }), true;

        await paginatedReply(
            interaction, combined, 5, Colors.info,
            `Case History - ${user.tag}`,
            (c) => {
                const roleList = [];
                if (c.prosecutor_id === user.id) roleList.push('Prosecutor');
                if (c.defendant_id  === user.id) roleList.push('Defendant');
                if (c.judge_id      === user.id) roleList.push('Judge');
                if (c.prosecutor_lawyer_id === user.id) roleList.push("Prosecutor's Lawyer");
                if (c.defense_lawyer_id    === user.id) roleList.push('Defense Lawyer');
                return `**${formatCaseId(c.case_number)}** - \`${c.status}\`\nRole: ${roleList.join(', ') || 'Jury'}\nFiled: ${ts(c.filed_at)}${c.verdict ? `\nVerdict: \`${c.verdict}\`` : ''}`;
            }
        );
        return true;
    }

    // ================================================================
    // /casecount
    // ================================================================
    if (cmd === 'casecount') {
        const { rows: totals } = await pool.query(
            `SELECT status, COUNT(*) as count FROM cases WHERE guild_id = $1 GROUP BY status ORDER BY status`,
            [guildId]
        );
        const { rows: verdicts } = await pool.query(
            `SELECT verdict, COUNT(*) as count FROM cases WHERE guild_id = $1 AND verdict IS NOT NULL GROUP BY verdict`,
            [guildId]
        );
        const { rows: totalRow } = await pool.query(
            `SELECT COUNT(*) as total FROM cases WHERE guild_id = $1`,
            [guildId]
        );

        const lines = [
            `**Total Cases:** ${totalRow[0]?.total || 0}`,
            '',
            '**By Status:**',
            ...totals.map(r => `- \`${r.status}\`: ${r.count}`),
            '',
            '**Verdicts:**',
            ...verdicts.map(r => `- \`${r.verdict}\`: ${r.count}`),
        ];

        return interaction.editReply({ embeds: [infoEmbed(Colors.info, 'Server Case Statistics', lines)] }), true;
    }

    // Command not found in this file
    return false;
}

module.exports = registerCommands2;
