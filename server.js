require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/driver',  require('./routes/profile'));
app.use('/api/admin',   require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// Admin SPA fallback
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Driver app fallback (all other routes)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚕 SAN Queue Scheduler running on port ${PORT}`);
  console.log(`   Driver App: http://localhost:${PORT}`);
  console.log(`   Admin Dashboard: http://localhost:${PORT}/admin\n`);

  // Start the scheduler
  const { startScheduler } = require('./scheduler');
  startScheduler();
});

module.exports = app;
