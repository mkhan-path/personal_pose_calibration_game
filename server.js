require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 4000;
const LABELS_FILE = path.join(__dirname, 'labels.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve image folders as static routes
app.use('/images', express.static(path.join(__dirname, 'cv model'), { dotfiles: 'allow' }));
app.use('/images2', express.static(path.join(__dirname, 'cv model_2', 'cv model'), { dotfiles: 'allow' }));

// --- Pairing logic ---

const DATASETS = [
  {
    name: 'cv_model',
    basePath: path.join(__dirname, 'cv model'),
    urlPrefix: '/images',
    splits: ['test', 'train']
  },
  {
    name: 'cv_model_2',
    basePath: path.join(__dirname, 'cv model_2', 'cv model'),
    urlPrefix: '/images2',
    splits: ['test', 'train']
  }
];

function buildPairs() {
  const pairs = [];

  for (const ds of DATASETS) {
    for (const split of ds.splits) {
      const leftDir = path.join(ds.basePath, split, 'left');
      const rightDir = path.join(ds.basePath, split, 'right');

      if (!fs.existsSync(leftDir) || !fs.existsSync(rightDir)) continue;

      const leftFiles = new Set(
        fs.readdirSync(leftDir).filter(f => /\.(png|jpg|jpeg|bmp|webp)$/i.test(f))
      );
      const rightFiles = new Set(
        fs.readdirSync(rightDir).filter(f => /\.(png|jpg|jpeg|bmp|webp)$/i.test(f))
      );

      // Intersection: only filenames present in both left and right
      const matched = [...leftFiles].filter(f => rightFiles.has(f)).sort();

      for (const filename of matched) {
        pairs.push({
          filename,
          dataset: ds.name,
          split,
          left_path: path.join(ds.basePath, split, 'left', filename),
          right_path: path.join(ds.basePath, split, 'right', filename),
          left_url: `${ds.urlPrefix}/${encodeURIComponent(split)}/left/${encodeURIComponent(filename)}`,
          right_url: `${ds.urlPrefix}/${encodeURIComponent(split)}/right/${encodeURIComponent(filename)}`
        });
      }
    }
  }

  return pairs;
}

// --- Labels persistence ---

function loadLabels() {
  if (fs.existsSync(LABELS_FILE)) {
    return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8'));
  }
  return {};
}

function saveLabels(labels) {
  fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
}

// --- Google Sheets ---

async function getSheetsClient() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!keyPath || !fs.existsSync(keyPath)) {
    throw new Error('Service account key file not found. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH in .env');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendToGoogleSheet(rows) {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID not set in .env');

  const sheets = await getSheetsClient();
  const columns = ['filename', 'left_path', 'right_path', 'dataset', 'split', 'label', 'timestamp'];

  // Check if header row exists
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:G1',
  });

  const values = [];
  if (!existing.data.values || existing.data.values.length === 0) {
    values.push(columns);
  }

  for (const r of rows) {
    values.push(columns.map(c => r[c] || ''));
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:G',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values.length;
}

// --- API routes ---

app.get('/api/pairs', (req, res) => {
  const pairs = buildPairs();
  const labels = loadLabels();
  res.json({ pairs, labels });
});

app.post('/api/label', (req, res) => {
  const { key, label } = req.body;
  if (!key || !label) {
    return res.status(400).json({ error: 'key and label required' });
  }
  const labels = loadLabels();
  labels[key] = {
    ...req.body,
    timestamp: new Date().toISOString()
  };
  saveLabels(labels);
  res.json({ ok: true });
});

app.get('/api/export', (req, res) => {
  const labels = loadLabels();
  const rows = Object.values(labels);
  if (rows.length === 0) {
    return res.status(400).send('No labels to export');
  }

  const columns = ['filename', 'left_path', 'right_path', 'dataset', 'split', 'label', 'timestamp'];
  const csvHeader = columns.join(',');
  const csvRows = rows.map(r =>
    columns.map(c => `"${(r[c] || '').replace(/"/g, '""')}"`).join(',')
  );

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="labels.csv"');
  res.send([csvHeader, ...csvRows].join('\n'));
});

app.post('/api/sync-sheets', async (req, res) => {
  try {
    const labels = loadLabels();
    const rows = Object.values(labels);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No labels to sync' });
    }
    const count = await appendToGoogleSheet(rows);
    res.json({ ok: true, rowsAppended: count });
  } catch (err) {
    console.error('Google Sheets sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  const pairs = buildPairs();
  console.log(`Pose Calibration Labeling Tool running at http://localhost:${PORT}`);
  console.log(`Found ${pairs.length} image pairs across ${DATASETS.length} datasets`);
});
