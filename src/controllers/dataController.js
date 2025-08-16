
const pool = require('../db');

// Función auxiliar para agrupar hijos por el ID del padre
const groupChildrenBy = (children, key) => {
    return children.reduce((acc, child) => {
        const parentId = child[key];
        if (!acc[parentId]) {
            acc[parentId] = [];
        }
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
        const attachmentsByIndicator = groupChildrenBy(attachments[0], 'indicator_id');
        const auditLogsByIndicator = groupChildrenBy(auditLogs[0], 'indicator_id');
        const decisionsByMeeting = groupChildrenBy(decisions[0], 'meeting_id');
        const repliesByThread = groupChildrenBy(threadReplies[0], 'thread_id');
        
        // Aquí podríamos agrupar las actualizaciones por action_plan_id si fuera necesario

        // 4. Ensamblar la estructura de datos final
        const assembledIndicators = indicators[0].map(indicator => ({
            ...indicator,
            historicalData: historicalDataByIndicator[indicator.id] || [],
            goals: goalsByIndicator[indicator.id] || [],
            observations: observationsByIndicator[indicator.id] || [],
            risks: risksByIndicator[indicator.id] || [],
            actionPlans: actionPlansByIndicator[indicator.id] || [],
            attachments: attachmentsByIndicator[indicator.id] || [],
            auditLog: auditLogsByIndicator[indicator.id] || [],
        }));

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

// NOTA: Esta función saveAppData es un placeholder.
// Una implementación real sería mucho más compleja, manejando inserciones,
// actualizaciones y eliminaciones de manera granular y con transacciones.
// Por ahora, el guardado se manejará en el frontend y se sincronizará
// a través de llamadas más específicas en el futuro.
exports.saveAppData = async (req, res) => {
    // La lógica de autorización ya se maneja en el frontend (simulado en apiService.ts)
    // El middleware de autenticación ya verificó al usuario.
    // Aquí iría la lógica para guardar en la base de datos, que es compleja.
    
    console.log("Recibida petición para guardar datos. Usuario:", req.user.name);
    console.log("Datos recibidos:", req.body);
    
    // Aquí deberíamos usar una transacción de base de datos para actualizar
    // todas las tablas de forma segura.
    
    res.status(200).json({ message: 'Datos recibidos. La lógica de guardado en DB está pendiente de implementación.' });
};
