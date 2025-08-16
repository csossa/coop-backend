
const pool = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.register = async (req, res) => {
    const { id, name, role, area, password, readThreadIds } = req.body;

    if (!id || !name || !role || !area || !password) {
        return res.status(400).json({ message: 'Todos los campos son requeridos para el registro.' });
    }

    try {
        // Verificar si el usuario ya existe
        const [existingUser] = await pool.query('SELECT * FROM users WHERE id = ? OR name = ?', [id, name]);
        if (existingUser.length > 0) {
            return res.status(409).json({ message: 'El ID o el nombre de usuario ya existen.' });
        }

        // Hashear la contraseña
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Guardar el nuevo usuario en la base de datos
        const newUser = {
            id,
            name,
            role,
            area,
            password: hashedPassword,
            readThreadIds: JSON.stringify(readThreadIds || [])
        };
        await pool.query('INSERT INTO users SET ?', newUser);

        res.status(201).json({ message: 'Usuario registrado exitosamente.' });

    } catch (error) {
        console.error("Error en el registro:", error);
        res.status(500).json({ message: 'Error en el servidor al registrar el usuario.' });
    }
};

exports.login = async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE name = ?', [username]);
        if (rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = rows[0];

        // Comparar la contraseña ingresada con la hasheada en la base de datos
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // Crear y firmar el token JWT
        const payload = {
            id: user.id,
            name: user.name,
            role: user.role,
            area: user.area
        };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

        // Preparar el objeto de usuario para enviar al frontend (sin la contraseña)
        const userToSend = { ...user };
        delete userToSend.password;

        res.json({
            token,
            user: userToSend
        });

    } catch (error) {
        console.error("Error en el login:", error);
        res.status(500).json({ message: 'Error en el servidor durante el inicio de sesión.' });
    }
};
