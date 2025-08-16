
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const dataRoutes = require('./routes/dataRoutes');

const app = express();

// Middlewares
app.use(cors()); // Permite peticiones desde el frontend
app.use(express.json({ limit: '10mb' })); // Permite al servidor entender JSON y aumenta el límite para adjuntos

// Rutas de la API
app.use('/api/auth', authRoutes);
app.use('/api/data', dataRoutes);

// Ruta de bienvenida para verificar que el servidor está funcionando
app.get('/', (req, res) => {
    res.send('API del Balance Social Cooperativo está funcionando correctamente.');
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
