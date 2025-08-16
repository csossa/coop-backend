
const express = require('express');
const router = express.Router();
const dataController = require('../controllers/dataController');
const authMiddleware = require('../middleware/authMiddleware');

// Protegemos todas las rutas de datos con el middleware de autenticación
router.use(authMiddleware);

// Ruta para obtener todos los datos de la aplicación
router.get('/app-data', dataController.getAppData);

// Ruta para guardar cambios en los datos de la aplicación
router.post('/app-data', dataController.saveAppData);

module.exports = router;
