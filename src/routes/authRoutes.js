
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Ruta para iniciar sesión
router.post('/login', authController.login);

// Ruta para registrar un nuevo usuario (útil para la configuración inicial)
// En un entorno real, esta ruta podría estar protegida para que solo administradores puedan crear usuarios.
router.post('/register', authController.register);

module.exports = router;
