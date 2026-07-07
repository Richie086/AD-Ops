const express = require('express');
const { generateReport } = require('../reportGen');
const { requireFeature } = require('../settings');

const router = express.Router();

router.post('/export', requireFeature('export'), (req, res) => {
  const { format, title, data, command } = req.body || {};
  if (!format || !title || data === undefined) {
    return res.status(400).json({ error: 'format, title, and data are required' });
  }
  try {
    const report = generateReport(format, title, data, { command });
    res.setHeader('Content-Type', report.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9_-]/gi, '_')}.${report.ext}"`);
    res.send(report.content);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
