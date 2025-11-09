// server/index.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS - allow frontend origin or all if not set
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

const PORT = process.env.PORT || 4000;

// Default image endpoint (common public path). You can override in .env.
const IMAGE_API_URL = process.env.PROVIDER_IMAGE_API_URL || 'https://api.stability.ai/v2beta/stable-image/generate/core';
const API_KEY = process.env.PROVIDER_API_KEY || '';

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * Save base64 image buffer to disk and return public path
 * returns a string like '/out/imagename.png'
 */
function saveBase64ImageToOut(base64String) {
  // strip data url if present
  const matches = base64String.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  let data = base64String;
  let ext = 'png';
  if (matches && matches.length === 3) {
    data = matches[2];
    const mime = matches[1]; // e.g. image/png
    if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
    else if (mime === 'image/webp') ext = 'webp';
    else ext = 'png';
  }

  const buffer = Buffer.from(data, 'base64');
  const filename = `image-${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`;
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, buffer);
  // return URL path (served by express)
  return `/out/${filename}`;
}

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Serve static public and out
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/out', express.static(OUT_DIR));

/**
 * POST /api/generate-image
 * Body: { prompt, width, height, samples }
 */
app.post('/api/generate-image', async (req, res) => {
  try {
    const prompt = (req.body.prompt || '').trim();
    const width = parseInt(req.body.width || process.env.DEFAULT_WIDTH || '512', 10);
    const height = parseInt(req.body.height || process.env.DEFAULT_HEIGHT || '512', 10);
    const samples = parseInt(req.body.samples || '1', 10);

    if (!prompt || prompt.length < 3) return res.status(400).json({ error: 'Prompt too short' });
    if (!API_KEY) return res.status(500).json({ error: 'Server not configured with PROVIDER_API_KEY' });

    // Build provider request body based on Stability v2beta image API
    const body = {
      text_prompts: [{ text: prompt }],
      width,
      height,
      samples
    };

    const pResp = await fetch(IMAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!pResp.ok) {
      const t = await pResp.text();
      console.error('Provider initial error:', pResp.status, t);
      return res.status(502).json({ error: `Provider initial error: ${pResp.status} ${pResp.statusText}`, details: t });
    }

    const pdata = await pResp.json();

    // Common Stability image response shapes:
    // - artifacts: [{base64: "..."}]
    // - or some responses might include a top-level image_base64
    const b64 =
      (pdata.artifacts && pdata.artifacts[0] && pdata.artifacts[0].base64) ||
      pdata.image_base64 ||
      null;

    if (!b64) {
      // Return provider payload for debugging
      return res.status(500).json({ error: 'No image returned from provider', payload: pdata });
    }

    const savedPath = saveBase64ImageToOut(b64);
    const publicUrl = savedPath; // relative path; frontend will prefix origin if needed

    return res.json({ imageUrl: publicUrl, providerResponse: pdata });

  } catch (err) {
    console.error('Server error (generate-image):', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Image API URL: ${IMAGE_API_URL}`);
});

