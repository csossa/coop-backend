
const pool = require('../db');
const bcrypt = require('bcryptjs');

// Función auxiliar para agrupar hijos por el ID del padre
const groupChildrenBy = (children, key) => {
    return children.reduce((acc, child) => {
        const parentId = child[key];
        if (!acc[parentId]) {
            acc[parentId] = [];
        }
        delete child[key]; // Clean up foreign key from child object
        acc[parentId].push(child);
        return acc;
    }, {});
};

exports.getAppData = async (req, res) => {
    try {
        // 1. Obtener todos los datos principales en paralelo
        const [
            users,
            strategicGoals,
            indicators,
            meetings,
            discussionThreads,
            notifications
        ] = await Promise.all([
            pool.query('SELECT id, name, role, area, readThreadIds FROM users'),
            pool.query('SELECT * FROM strategic_goals'),
            pool.query('SELECT * FROM indicators'),
            pool.query('SELECT * FROM meetings'),
            pool.query('SELECT * FROM discussion_threads'),
            pool.query('SELECT * FROM notifications'),
        ]);

        // 2. Obtener todos los datos secundarios (hijos) en paralelo
        const [
            historicalData,
            goals,
            observations,
            risks,
            actionPlans,
            actionPlanUpdates,
            attachments,
            auditLogs,
            decisions,
            threadReplies
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

        // 3. Agrupar los datos secundarios por el ID de su padre
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
        
        // 4. Ensamblar la estructura de datos final
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
            }
        });

        const assembledMeetings = meetings[0].map(meeting => ({
            ...meeting,
            decisions: decisionsByMeeting[meeting.id] || [],
        }));
        
        const assembledThreads = discussionThreads[0].map(thread => ({
            ...thread,
            replies: repliesByThread[thread.id] || [],
        }));
        
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

// Helper robusto para sincronizar colecciones secundarias (eliminar todo y luego insertar en bloque)
const syncSubCollection = async (connection, { table, parentIdKey, parentId, collection, columns }) => {
    await connection.query(`DELETE FROM ${table} WHERE ${parentIdKey} = ?`, [parentId]);
    if (collection && collection.length > 0) {
        const values = collection.map(item => 
            [parentId, ...columns.map(col => item[col] === undefined ? null : item[col])]
        );
        const allColumns = [parentIdKey, ...columns];
        await connection.query(`INSERT INTO ${table} (${allColumns.join(',')}) VALUES ?`, [values]);
    }
};


exports.saveAppData = async (req, res) => {
    const dataToSave = req.body;
    const currentUser = req.user; // from authMiddleware
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // --- USERS ---
        if (dataToSave.users) {
            if (currentUser.role !== 'Administrador') {
                throw { status: 403, message: 'No tiene permiso para gestionar usuarios.' };
            }
            const [existingUsers] = await connection.query('SELECT id FROM users');
            const existingUserIds = new Set(existingUsers.map(u => u.id));
            const incomingUserIds = new Set(dataToSave.users.map(u => u.id));
            const userIdsToDelete = [...existingUserIds].filter(id => !incomingUserIds.has(id) && id !== currentUser.id);

            if (userIdsToDelete.length > 0) {
                await connection.query('DELETE FROM users WHERE id IN (?)', [userIdsToDelete]);
            }

            for (const user of dataToSave.users) {
                 const [existing] = await connection.query('SELECT password FROM users WHERE id = ?', [user.id]);
                 let passwordToSave = existing.length ? existing[0].password : null;
                 
                 if (user.password && !user.password.startsWith('$2a$')) {
                     const salt = await bcrypt.genSalt(10);
                     passwordToSave = await bcrypt.hash(user.password, salt);
                 }
                 
                 await connection.query(
                    `INSERT INTO users (id, name, role, area, password, readThreadIds) VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE name=VALUES(name), role=VALUES(role), area=VALUES(area), password=VALUES(password), readThreadIds=VALUES(readThreadIds)`,
                    [user.id, user.name, user.role, user.area, passwordToSave, JSON.stringify(user.readThreadIds || [])]
                 );
            }
        }

        // --- INDICATORS & ALL SUB-COLLECTIONS ---
        if (dataToSave.indicators) {
            for (const indicator of dataToSave.indicators) {
                const { id, historicalData, goals, observations, risks, actionPlans, attachments, auditLog, ...indicatorData } = indicator;
                
                // Authorization Check
                const [originalIndicatorResult] = await connection.query('SELECT responsibleArea FROM indicators WHERE id = ?', [id]);
                if (currentUser.role === 'Gerente de Área' && originalIndicatorResult.length > 0 && originalIndicatorResult[0].responsibleArea !== currentUser.area) {
                    throw { status: 403, message: `No tiene permiso para editar el indicador "${indicator.name}".` };
                }

                // Save main indicator data
                await connection.query(
                    `INSERT INTO indicators (id, principle, name, calculation, purpose, responsibleArea, strategicGoalId) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE principle=VALUES(principle), name=VALUES(name), calculation=VALUES(calculation), purpose=VALUES(purpose), responsibleArea=VALUES(responsibleArea), strategicGoalId=VALUES(strategicGoalId)`,
                    [id, indicatorData.principle, indicatorData.name, indicatorData.calculation, indicatorData.purpose, indicatorData.responsibleArea, indicatorData.strategicGoalId || null]
                );

                // Sync all sub-collections
                await syncSubCollection(connection, { table: 'historical_data', parentIdKey: 'indicator_id', parentId: id, collection: historicalData, columns: ['year', 'value', 'formattedValue'] });
                await syncSubCollection(connection, { table: 'goals', parentIdKey: 'indicator_id', parentId: id, collection: goals, columns: ['year', 'target'] });
                
                // FIX: Map frontend `id` (ISO string) to DB `timestamp` column for observations
                const observationsForDb = (observations || []).map(o => ({ ...o, timestamp: o.id }));
                await syncSubCollection(connection, { table: 'observations', parentIdKey: 'indicator_id', parentId: id, collection: observationsForDb, columns: ['id', 'author', 'role', 'date', 'text', 'timestamp'] });

                // FIX: Map frontend `createdDate` to DB `timestamp` column for risks
                const risksForDb = (risks || []).map(r => ({ ...r, timestamp: r.createdDate }));
                await syncSubCollection(connection, { table: 'risks', parentIdKey: 'indicator_id', parentId: id, collection: risksForDb, columns: ['id', 'title', 'description', 'impact', 'probability', 'riskScore', 'mitigationPlan', 'status', 'owner', 'timestamp'] });
                
                await syncSubCollection(connection, { table: 'attachments', parentIdKey: 'indicator_id', parentId: id, collection: attachments, columns: ['id', 'fileName', 'fileType', 'fileSize', 'dataUrl', 'uploadedBy', 'uploadDate'] });
                await syncSubCollection(connection, { table: 'audit_logs', parentIdKey: 'indicator_id', parentId: id, collection: auditLog, columns: ['id', 'timestamp', 'user', 'action', 'details'] });

                // Special handling for Action Plans and their updates
                await connection.query('DELETE FROM action_plan_updates WHERE action_plan_id IN (SELECT id FROM action_plans WHERE indicator_id = ?)', [id]);
                await connection.query('DELETE FROM action_plans WHERE indicator_id = ?', [id]);
                if (actionPlans && actionPlans.length > 0) {
                    for (const p of actionPlans) {
                        await connection.query('INSERT INTO action_plans (id, indicator_id, title, description, owner, status, dueDate, createdDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [p.id, id, p.title, p.description, p.owner, p.status, p.dueDate, p.createdDate]);
                        if (p.updates && p.updates.length > 0) {
                             const updateValues = p.updates.map(u => [u.id, p.id, u.date, u.author, u.text, u.statusChange || null, JSON.stringify(u.attachment || null)]);
                            await connection.query('INSERT INTO action_plan_updates (id, action_plan_id, date, author, text, statusChange, attachment) VALUES ?', [updateValues]);
                        }
                    }
                }
            }
        }
        
        // --- STRATEGIC GOALS ---
        if (dataToSave.strategicGoals) {
            if (currentUser.role !== 'Administrador') throw { status: 403, message: 'No tiene permiso para gestionar Objetivos Estratégicos.' };
            await connection.query('DELETE FROM strategic_goals');
            if(dataToSave.strategicGoals.length > 0) {
                 const values = dataToSave.strategicGoals.map(g => [g.id, g.title, g.description, g.targetDate]);
                 await connection.query('INSERT INTO strategic_goals (id, title, description, targetDate) VALUES ?', [values]);
            }
        }

        // --- MEETINGS ---
        if (dataToSave.meetings) {
            if (!['Administrador', 'Junta de Vigilancia'].includes(currentUser.role)) throw { status: 403, message: 'No tiene permiso para gestionar reuniones.' };
            await connection.query('DELETE FROM decisions');
            await connection.query('DELETE FROM meetings');
            for (const meeting of dataToSave.meetings) {
                await connection.query('INSERT INTO meetings (id, date, attendees, agenda, minutes) VALUES (?, ?, ?, ?, ?)', [meeting.id, meeting.date, meeting.attendees, meeting.agenda, meeting.minutes]);
                if (meeting.decisions && meeting.decisions.length > 0) {
                    const values = meeting.decisions.map(d => [d.id, meeting.id, d.text, d.responsibleUserId, d.dueDate, d.status]);
                    await connection.query('INSERT INTO decisions (id, meeting_id, text, responsibleUserId, dueDate, status) VALUES ?', [values]);
                }
            }
        }
        
        // --- DISCUSSION THREADS ---
        if (dataToSave.discussionThreads) {
            await connection.query('DELETE FROM thread_replies');
            await connection.query('DELETE FROM discussion_threads');
            for (const thread of dataToSave.discussionThreads) {
                // FIX: Removed authorName from INSERT to match schema
                await connection.query('INSERT INTO discussion_threads (id, title, content, authorId, timestamp, principleTag) VALUES (?, ?, ?, ?, ?, ?)', [thread.id, thread.title, thread.content, thread.authorId, thread.timestamp, thread.principleTag || null]);
                if (thread.replies && thread.replies.length > 0) {
                    // FIX: Removed authorName from INSERT to match schema
                    const values = thread.replies.map(r => [r.id, thread.id, r.authorId, r.timestamp, r.content]);
                    await connection.query('INSERT INTO thread_replies (id, thread_id, authorId, timestamp, content) VALUES ?', [values]);
                }
            }
        }

        // --- NOTIFICATIONS ---
        if (dataToSave.notifications) {
            await connection.query('DELETE FROM notifications');
            if (dataToSave.notifications.length > 0) {
                const values = dataToSave.notifications.map(n => [n.id, n.userId, n.type, n.message, n.relatedIndicatorId || null, n.relatedMeetingId || null, n.relatedThreadId || null, n.isRead ? 1 : 0, n.timestamp]);
                await connection.query('INSERT INTO notifications (id, userId, type, message, relatedIndicatorId, relatedMeetingId, relatedThreadId, isRead, timestamp) VALUES ?', [values]);
            }
        }

        await connection.commit();
        res.status(200).json({ message: 'Datos guardados exitosamente.' });
    } catch (error) {
        await connection.rollback();
        if (error.status === 403) {
            return res.status(403).json({ message: error.message });
        }
        console.error("Error al guardar datos:", error);
        res.status(500).json({ message: 'Error en el servidor al guardar los datos.' });
    } finally {
        connection.release();
    }
};
