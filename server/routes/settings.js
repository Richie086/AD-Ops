const express = require('express');
const { getPublicSettings } = require('../settings');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/branding', (req, res) => {
  res.json(getPublicSettings().branding);
});

router.get('/', requireLogin, (req, res) => {
  res.json(getPublicSettings());
});

module.exports = router;
