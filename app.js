// Import necessary modules
const express = require('express');
const bodyParser = require('body-parser'); // Import body-parser
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');
const moment = require('moment-timezone'); // Import moment-timezone

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const db = new sqlite3.Database('mydatabase.db');

// Middleware setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Use body-parser middleware
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(bodyParser.json()); // Parse JSON bodies

app.use(express.static('public'));

app.use(session({
    secret: 'your-secret-key', // replace with your own secret key
    resave: false,
    saveUninitialized: true
}));

// SQLite database initialization
db.serialize(() => {
    // Create users table if it doesn't exist
    db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password TEXT, photo TEXT)');

    // Check if the bio column exists and add it if not
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err) {
            console.error("Error retrieving table info:", err);
            return;
        }

        const columnNames = columns.map(column => column.name);
        if (!columnNames.includes('bio')) {
            db.run("ALTER TABLE users ADD COLUMN bio TEXT", (err) => {
                if (err) {
                    console.error("Error adding bio column:", err);
                } else {
                    console.log("Bio column added successfully.");
                }
            });
        }
    });

    // Create messages table if it doesn't exist
    db.run('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)');
});

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Routes
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/register', (req, res) => {
    res.render('register');
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, password], function(err) {
        if (err) {
            return console.log(err.message);
        }
        console.log(`A new user has been registered with username: ${username}`);
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (err) {
            return console.log(err.message);
        }
        if (user) {
            req.session.userId = user.id;
            console.log(`User ${username} has logged in`);
            res.redirect('/profile/' + user.id);
        } else {
            res.send('Login failed');
        }
    });
});

app.get('/profile/:id', (req, res) => {
    const id = req.params.id;
    const isOwner = req.session.userId == id;
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, user) => {
        if (err) {
            return console.log(err.message);
        }
        if (user) {
            res.render('profile', { user, isOwner });
        } else {
            res.send('User not found');
        }
    });
});

app.post('/uploadPhoto', upload.single('photo'), (req, res) => {
    const userId = req.body.userId;
    const photo = req.file ? req.file.filename : null;
    db.run("UPDATE users SET photo = ? WHERE id = ?", [photo, userId], function(err) {
        if (err) {
            return console.log(err.message);
        }
        res.redirect('/profile/' + userId);
    });
});

app.post('/updateBio', (req, res) => {
    const { userId, bio } = req.body;

    // Log incoming request data for debugging
    console.log('Update Bio Request:', { userId, bio });

    // Execute the database update query
    db.run("UPDATE users SET bio = ? WHERE id = ?", [bio, userId], function(err) {
        if (err) {
            // Log the error message to the console
            console.log('Database Error:', err.message);
            return res.send('Error updating bio: ' + err.message); // Include error message in response for debugging
        }
        console.log('Bio updated for user:', userId);
        res.redirect('/profile/' + userId);
    });
});



app.get('/search', (req, res) => {
    const username = req.query.username;
    db.all("SELECT * FROM users WHERE username LIKE ?", [`%${username}%`], (err, users) => {
        if (err) {
            return console.log(err.message);
        }
        res.render('search', { users });
    });
});

app.get('/message_center', (req, res) => {
    const userId = req.session.userId;
    const selectedUserId = req.query.selectedUserId || ''; // Get selected user from query or default to empty string
    db.all('SELECT id, username FROM users WHERE id != ?', [userId], (err, users) => {
        if (err) {
            return res.send('Error fetching users.');
        }
        db.all('SELECT m.id, u.username as sender, m.content, m.timestamp FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.receiver_id = ? OR m.sender_id = ? ORDER BY m.timestamp DESC', [userId, userId], (err, messages) => {
            if (err) {
                return res.send('Error fetching messages.');
            }
            res.render('message_center', { users, messages, userId, selectedUserId });
        });
    });
});

app.post('/message', (req, res) => {
    const { sender_id, receiver_id, content } = req.body;
    const timestamp = moment().tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss'); // Format timestamp in IST
    db.run('INSERT INTO messages (sender_id, receiver_id, content, timestamp) VALUES (?, ?, ?, ?)', [sender_id, receiver_id, content, timestamp], function(err) {
        if (err) {
            return res.send('Error sending message.');
        }
        db.get('SELECT username FROM users WHERE id = ?', [sender_id], (err, sender) => {
            if (err) {
                return res.send('Error fetching sender information.');
            }
            io.to(receiver_id).emit('new_message', { sender: sender.username, content, timestamp, receiver_id });

            // Redirect back to message center with selected user
            res.redirect(`/message_center?selectedUserId=${receiver_id}`);
        });
    });
});

// Socket.io setup for real-time messaging
io.on('connection', (socket) => {
    console.log('A user connected');
    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`User joined room: ${room}`);
    });
    socket.on('disconnect', () => {
        console.log('A user disconnected');
    });
});

// Server setup
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
