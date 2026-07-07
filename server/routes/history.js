const express = require('express');
const { listHistory, getHistoryRecord } = require('../db');
const { getHistoryLimit } = require('../settings');

const router = express.Router();

// Viewers/operators see only their own history. Admins can pass ?all=1
// to see everyone's (useful for oversight of what operators have run).
router.get('/', (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const all = isAdmin && req.query.all === '1';
  const rows = listHistory(req.session.username, { all, limit: getHistoryLimit() });
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const record = getHistoryRecord(Number(req.params.id), req.session.username, isAdmin);
  if (!record) return res.status(404).json({ error: 'History entry not found' });
  res.json(record);
});

module.exports = router;
