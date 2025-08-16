
const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ message: 'No se proveyó un token, autorización denegada.' });
    }

    // El token viene en formato "Bearer <token>"
    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Token malformado.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Añade la información del usuario (id, role, etc.) a la petición
        next();
    } catch (err) {
        res.status(401).json({ message: 'El token no es válido.' });
    }
};
