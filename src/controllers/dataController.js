const pool = require('../db');
const bcrypt = require('bcryptjs');

// --- Helper Functions ---

// Groups an array of child objects by a foreign key.
const groupChildrenBy = (children, key) => {
    return children.reduce((acc, child) => {
        const parentId = child[key];
        if (!acc[parentId]) {
            acc[parentId] = [];
        }
        delete child[key]; // Clean up foreign key from child object for cleaner output
        acc[parentId].push(child);
        return acc;
    }, {});
};

// A robust function to format a date string into a MySQL DATETIME compatible format.
// keepTime = true -> YYYY-MM-DD HH:MM:SS
// keepTime = false -> YYYY-MM-DD 00:00:00
const toMySQLDateTime = (dateString, keepTime = false) => {
    if (!dateString) return null;
    
    let date;
    // `new Date(isoString)` works reliably.
    // For `dd/mm/yyyy`, we need to parse manually to avoid ambiguity.
    const dmyMatch = String(dateString).match(/^(\d{2})[./-](\d{2})[./-](\d{4})/);
    
    if (dmyMatch) {
        // It's dd/mm/yyyy. new Date(yyyy, mm-1, dd) creates a date in the server's local timezone.
        date = new Date(dmyMatch[3], dmyMatch[2] - 1, dmyMatch[1]);
    } else {
        // Assume ISO 8601 or another format that `new Date` can parse.
        date = new Date(dateString);
    }
    
    if (isNaN(date.getTime())) {
        console.warn(`Invalid date format encountered, could not parse: ${dateString}`);
        return null;
    }

    // Format to YYYY-MM-DD HH:MM:SS, respecting the keepTime flag.
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (keepTime) {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } else {
        return `${year}-${month}-${day} 00:00:00`;
    }
};


// --- GET DATA ---

exports.getAppData = async (req, res) => {
    // The existing getAppData logic is sound and efficient.
    try {
        const [
            users, strategicGoals, indicators, meetings, discussionThreads, notifications
        ] = await Promise.all([
            pool.query('SELECT id, name, role, area, readThreadIds FROM users'),
            pool.query('SELECT * FROM strategic_goals'),
            pool.query('SELECT * FROM indicators'),
            pool.query('SELECT * FROM meetings'),
            pool.query('SELECT * FROM discussion_threads'),
            pool.query('SELECT * FROM notifications'),
        ]);

        const [
            historicalData, goals, observations, risks, actionPlans, actionPlanUpdates, attachments, auditLogs, decisions, threadReplies
        ] = await Promise.all([
            pool.query('SELECT * FROM historical_data'),
            pool.query('SELECT * FROM goals'),
            pool.query('SELECT * FROM observations'),
            pool.query('SELECT * FROM risks'),
            pool.query('SELECT * FROM action_plans'),
            pool.query('SELECT * FROM action_plan_updates'),
            pool.query('SELECT * FROM attachments'),
            pool.query('SELECT * FROM audit_logs'),
            pool.query('SELECT * FROM decisions'),
            pool.query('SELECT * FROM thread_replies'),
        ]);

        const historicalDataByIndicator = groupChildrenBy(historicalData[0], 'indicator_id');
        const goalsByIndicator = groupChildrenBy(goals[0], 'indicator_id');
        const observationsByIndicator = groupChildrenBy(observations[0], 'indicator_id');
        const risksByIndicator = groupChildrenBy(risks[0], 'indicator_id');
        const actionPlansByIndicator = groupChildrenBy(actionPlans[0], 'indicator_id');
        const updatesByActionPlan = groupChildrenBy(actionPlanUpdates[0], 'action_plan_id');
        const attachmentsByIndicator = groupChildrenBy(attachments[0], 'indicator_id');
        const auditLogsByIndicator = groupChildrenBy(auditLogs[0], 'indicator_id');
        const decisionsByMeeting = groupChildrenBy(decisions[0], 'meeting_id');
        const repliesByThread = groupChildrenBy(threadReplies[0], 'thread_id');
        
        const assembledIndicators = indicators[0].map(indicator => {
            const plans = actionPlansByIndicator[indicator.id] || [];
            plans.forEach(plan => {
                plan.updates = updatesByActionPlan[plan.id] || [];
            });

            return {
                ...indicator,
                historicalData: historicalDataByIndicator[indicator.id] || [],
                goals: goalsByIndicator[indicator.id] || [],
                observations: observationsByIndicator[indicator.id] || [],
                risks: risksByIndicator[indicator.id] || [],
                actionPlans: plans,
                attachments: attachmentsByIndicator[indicator.id] || [],
                auditLog: auditLogsByIndicator[indicator.id] || [],
            };
        });

        const assembledMeetings = meetings[0].map(meeting => ({ ...meeting, decisions: decisionsByMeeting[meeting.id] || [] }));
        const assembledThreads = discussionThreads[0].map(thread => ({ ...thread, replies: repliesByThread[thread.id] || [] }));
        
        res.json({
            users: users[0],
            strategicGoals: strategicGoals[0],
            indicators: assembledIndicators,
            meetings: assembledMeetings,
            discussionThreads: assembledThreads,
            notifications: notifications[0],
        });

    } catch (error) {
        console.error("Error al obtener los datos de la aplicación:", error);
        res.status(500).json({ message: 'Error en el servidor al obtener los datos.' });
    }
};

// --- SAVE DATA (REFACTORED) ---

exports.saveAppData = async (req, res) => {
    const data = req.body;
    const currentUser = req.user;
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // --- SYNCHRONIZE USERS ---
        if (data.users) {
            if (currentUser.role !== 'Administrador') {
                throw { status: 403, message: 'No tiene permiso para gestionar usuarios.' };
            }
            const [existingUsers] = await connection.query('SELECT id FROM users');
            const existingIds = new Set(existingUsers.map(u => u.id));
            const incomingIds = new Set(data.users.map(u => u.id));
            const idsToDelete = [...existingIds].filter(id => !incomingIds.has(id) && id !== currentUser.id);
            if (idsToDelete.length > 0) {
                await connection.query('DELETE FROM users WHERE id IN (?)', [idsToDelete]);
            }
            for (const user of data.users) {
                const [existing] = await connection.query('SELECT password FROM users WHERE id = ?', [user.id]);
                let passwordToSave = existing.length ? existing[0].password : null;
                if (user.password && !user.password.startsWith('$2a$')) {
                    passwordToSave = await bcrypt.hash(user.password, await bcrypt.genSalt(10));
                }
                await connection.query(
                    `INSERT INTO users (id, name, role, area, password, readThreadIds) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), area=VALUES(area), password=VALUES(password), readThreadIds=VALUES(readThreadIds)`,
                    [user.id, user.name, user.role, user.area, passwordToSave, JSON.stringify(user.readThreadIds || [])]
                );
            }
        }
        
        // --- SYNCHRONIZE INDICATORS & CHILDREN ---
        if (data.indicators) {
             const incomingIndicatorIds = new Set(data.indicators.map(i => i.id));
             const [dbIndicators] = await connection.query('SELECT id FROM indicators');
             const dbIndicatorIds = new Set(dbIndicators.map(i => i.id));
             const indicatorsToDelete = [...dbIndicatorIds].filter(id => !incomingIndicatorIds.has(id));

             if (indicatorsToDelete.length > 0) {
                 const tables = ['historical_data', 'goals', 'observations', 'risks', 'attachments', 'audit_logs'];
                 for (const table of tables) {
                     await connection.query(`DELETE FROM ${table} WHERE indicator_id IN (?)`, [indicatorsToDelete]);
                 }
                 await connection.query(`DELETE FROM action_plan_updates WHERE action_plan_id IN (SELECT id FROM action_plans WHERE indicator_id IN (?))`, [indicatorsToDelete]);
                 await connection.query(`DELETE FROM action_plans WHERE indicator_id IN (?)`, [indicatorsToDelete]);
                 await connection.query('DELETE FROM indicators WHERE id IN (?)', [indicatorsToDelete]);
             }

            for (const indicator of data.indicators) {
                await connection.query(
                    `INSERT INTO indicators (id, principle, name, calculation, purpose, responsibleArea, strategicGoalId) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE principle=VALUES(principle), name=VALUES(name), calculation=VALUES(calculation), purpose=VALUES(purpose), responsibleArea=VALUES(responsibleArea), strategicGoalId=VALUES(strategicGoalId)`,
                    [indicator.id, indicator.principle, indicator.name, indicator.calculation, indicator.purpose, indicator.responsibleArea, indicator.strategicGoalId || null]
                );

                await connection.query('DELETE FROM historical_data WHERE indicator_id = ?', [indicator.id]);
                if (indicator.historicalData?.length) {
                    const values = indicator.historicalData.map(d => [indicator.id, d.year, d.value, d.formattedValue]);
                    await connection.query('INSERT INTO historical_data (indicator_id, year, value, formattedValue) VALUES ?', [values]);
                }
                
                await connection.query('DELETE FROM goals WHERE indicator_id = ?', [indicator.id]);
                if (indicator.goals?.length) {
                    const values = indicator.goals.map(g => [indicator.id, g.year, g.target]);
                    await connection.query('INSERT INTO goals (indicator_id, year, target) VALUES ?', [values]);
                }

                await connection.query('DELETE FROM observations WHERE indicator_id = ?', [indicator.id]);
                if (indicator.observations?.length) {
                    const values = indicator.observations.map(o => [indicator.id, o.id, o.author, o.role, toMySQLDateTime(o.date, true), o.text]);
                    await connection.query('INSERT INTO observations (indicator_id, id, author, role, date, text) VALUES ?', [values]);
                }
                
                await connection.query('DELETE FROM risks WHERE indicator_id = ?', [indicator.id]);
                if (indicator.risks?.length) {
                    const values = indicator.risks.map(r => [indicator.id, r.id, r.title, r.description, r.impact, r.probability, r.riskScore, r.mitigationPlan, r.status, r.owner, toMySQLDateTime(r.createdDate, true)]);
                    await connection.query('INSERT INTO risks (indicator_id, id, title, description, impact, probability, riskScore, mitigationPlan, status, owner, createdDate) VALUES ?', [values]);
                }
                
                // --- CENTRALIZED ATTACHMENT HANDLING ---
                const allAttachments = [];
                if (indicator.attachments?.length) {
                    allAttachments.push(...indicator.attachments);
                }
                if (indicator.actionPlans?.length) {
                    indicator.actionPlans.forEach(plan => {
                        plan.updates?.forEach(update => {
                            if (update.attachment) {
                                allAttachments.push(update.attachment);
                            }
                        });
                    });
                }
                const uniqueAttachments = Object.values(allAttachments.reduce((acc, cur) => {
                    if (cur && cur.id) acc[cur.id] = cur;
                    return acc;
                }, {}));

                await connection.query('DELETE FROM attachments WHERE indicator_id = ?', [indicator.id]);
                if (uniqueAttachments.length > 0) {
                    const attachmentValues = uniqueAttachments.map(f => [indicator.id, f.id, f.fileName, f.fileType, f.fileSize, f.dataUrl, f.uploadedBy, toMySQLDateTime(f.uploadDate, true)]);
                    await connection.query('INSERT INTO attachments (indicator_id, id, fileName, fileType, fileSize, dataUrl, uploadedBy, uploadDate) VALUES ?', [attachmentValues]);
                }
                // --- END ATTACHMENT HANDLING ---

                await connection.query('DELETE FROM audit_logs WHERE indicator_id = ?', [indicator.id]);
                if (indicator.auditLog?.length) {
                    const values = indicator.auditLog.map(l => [indicator.id, l.id, toMySQLDateTime(l.id, true), l.user, l.action, l.details]);
                    await connection.query('INSERT INTO audit_logs (indicator_id, id, timestamp, user, action, details) VALUES ?', [values]);
                }

                await connection.query('DELETE FROM action_plan_updates WHERE action_plan_id IN (SELECT id FROM action_plans WHERE indicator_id = ?)', [indicator.id]);
                await connection.query('DELETE FROM action_plans WHERE indicator_id = ?', [indicator.id]);
                if (indicator.actionPlans?.length) {
                    for (const plan of indicator.actionPlans) {
                        await connection.query('INSERT INTO action_plans (id, indicator_id, title, description, owner, status, dueDate, createdDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                            [plan.id, indicator.id, plan.title, plan.description, plan.owner, plan.status, toMySQLDateTime(plan.dueDate, false), toMySQLDateTime(plan.createdDate, true)]);
                        if (plan.updates?.length) {
                            const updateValues = plan.updates.map(u => [u.id, plan.id, toMySQLDateTime(u.date, true), u.author, u.text, u.statusChange, u.attachment?.id || null]);
                            await connection.query('INSERT INTO action_plan_updates (id, action_plan_id, date, author, text, statusChange, attachmentId) VALUES ?', [updateValues]);
                        }
                    }
                }
            }
        }

        // --- SYNCHRONIZE TOP-LEVEL COLLECTIONS ---
        const syncTopLevel = async (tableName, collection, columns, dateConfig = {}) => {
             await connection.query(`DELETE FROM ${tableName}`);
             if (collection?.length) {
                 const values = collection.map(item =>
                     columns.map(col => {
                         const val = item[col];
                         const keepTime = dateConfig[col] === true;
                         return dateConfig.hasOwnProperty(col) ? toMySQLDateTime(val, keepTime) : val;
                     })
                 );
                 await connection.query(`INSERT INTO ${tableName} (${columns.join(',')}) VALUES ?`, [values]);
             }
        };
        
        if (data.strategicGoals) await syncTopLevel('strategic_goals', data.strategicGoals, ['id', 'title', 'description', 'targetDate'], { targetDate: false });
        if (data.notifications) await syncTopLevel('notifications', data.notifications, ['id', 'userId', 'type', 'message', 'relatedIndicatorId', 'relatedMeetingId', 'relatedThreadId', 'isRead', 'timestamp'], { timestamp: true });
        
        if (data.meetings) {
            await connection.query('DELETE FROM decisions');
            await connection.query('DELETE FROM meetings');
            for (const meeting of data.meetings) {
                await connection.query('INSERT INTO meetings (id, date, attendees, agenda, minutes) VALUES (?, ?, ?, ?, ?)', 
                    [meeting.id, toMySQLDateTime(meeting.date, true), meeting.attendees, meeting.agenda, meeting.minutes]);
                if (meeting.decisions?.length) {
                    const decisionValues = meeting.decisions.map(d => [d.id, meeting.id, d.text, d.responsibleUserId, toMySQLDateTime(d.dueDate, false), d.status]);
                    await connection.query('INSERT INTO decisions (id, meeting_id, text, responsibleUserId, dueDate, status) VALUES ?', [decisionValues]);
                }
            }
        }

        if (data.discussionThreads) {
            await connection.query('DELETE FROM thread_replies');
            await connection.query('DELETE FROM discussion_threads');
            for (const thread of data.discussionThreads) {
                await connection.query('INSERT INTO discussion_threads (id, title, content, authorId, timestamp, principleTag) VALUES (?, ?, ?, ?, ?, ?)',
                    [thread.id, thread.title, thread.content, thread.authorId, toMySQLDateTime(thread.timestamp, true), thread.principleTag]);
                if (thread.replies?.length) {
                    const replyValues = thread.replies.map(r => [r.id, thread.id, r.authorId, toMySQLDateTime(r.timestamp, true), r.content]);
                    await connection.query('INSERT INTO thread_replies (id, thread_id, authorId, timestamp, content) VALUES ?', [replyValues]);
                }
            }
        }

        await connection.commit();
        res.status(200).json({ message: 'Datos guardados exitosamente.' });
    } catch (error) {
        await connection.rollback();
        console.error("Error al guardar datos:", error);
        res.status(error.status || 500).json({ message: error.message || 'Error en el servidor al guardar los datos.' });
    } finally {
        connection.release();
    }
};
