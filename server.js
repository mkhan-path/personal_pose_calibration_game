require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 4000;

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

      const matched = [...leftFiles].filter(f => rightFiles.has(f)).sort();

      for (const filename of matched) {
        pairs.push({
          filename,
          dataset: ds.name,
          split,
          left_url: `${ds.urlPrefix}/${encodeURIComponent(split)}/left/${encodeURIComponent(filename)}`,
          right_url: `${ds.urlPrefix}/${encodeURIComponent(split)}/right/${encodeURIComponent(filename)}`
        });
      }
    }
  }

  return pairs;
}

// --- Google Sheets ---

const COLUMNS = ['filename', 'dataset', 'split', 'label', 'timestamp', 'contested', 'contest_reason'];

async function getSheetsClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;

  let auth;
  if (keyJson) {
    const credentials = JSON.parse(keyJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else if (keyPath && fs.existsSync(keyPath)) {
    auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    throw new Error('No service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SERVICE_ACCOUNT_KEY_PATH');
  }

  return google.sheets({ version: 'v4', auth });
}

async function appendToGoogleSheet(rows) {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID not set');

  const sheets = await getSheetsClient();

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:G1',
  });

  const values = [];
  if (!existing.data.values || existing.data.values.length === 0) {
    values.push(COLUMNS);
  }

  for (const r of rows) {
    values.push(COLUMNS.map(c => r[c] || ''));
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
  res.json({ pairs });
});

app.post('/api/sync-sheets', async (req, res) => {
  try {
    const { labels } = req.body;
    if (!labels || Object.keys(labels).length === 0) {
      return res.status(400).json({ error: 'No labels to sync' });
    }
    const rows = Object.values(labels);
    const count = await appendToGoogleSheet(rows);
    res.json({ ok: true, rowsAppended: count });
  } catch (err) {
    console.error('Google Sheets sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contest', async (req, res) => {
  try {
    const { filename, timestamp, reason } = req.body;
    if (!filename || !timestamp || !reason) {
      return res.status(400).json({ error: 'filename, timestamp, and reason required' });
    }

    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error('SHEET_ID not set');

    const sheets = await getSheetsClient();

    // Read all rows to find the matching one
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:G',
    });

    const rows = data.data.values || [];
    let matchRow = -1;
    for (let i = 1; i < rows.length; i++) {
      // Column A = filename, Column E = timestamp
      if (rows[i][0] === filename && rows[i][4] === timestamp) {
        matchRow = i + 1; // 1-indexed for Sheets API
        break;
      }
    }

    if (matchRow === -1) {
      return res.status(404).json({ error: 'Row not found in sheet' });
    }

    // Update columns F (contested) and G (contest_reason)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Sheet1!F${matchRow}:G${matchRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['yes', reason]],
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Contest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start server only when run directly (not on Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    const pairs = buildPairs();
    console.log(`Pose Calibration Labeling Tool running at http://localhost:${PORT}`);
    console.log(`Found ${pairs.length} image pairs across ${DATASETS.length} datasets`);
  });
}

// Export for Vercel serverless
module.exports = app;
