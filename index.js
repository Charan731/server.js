// server/index.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '20mb' }));

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

const PORT = process.env.PORT || 4000;
const IMAGE_API_URL = process.env.PROVIDER_IMAGE_API_URL || 'https://api.stability.ai/v2beta/stable-image/generate/core';
const API_KEY = process.env.PROVIDER_API_KEY || '';

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function saveBase64ImageToOut(base64String) {
  const matches = base64String.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  let data = base64String;
  let ext = 'png';
  if (matches && matches.length === 3) {
    data = matches[2];
    const mime = matches[1];
    if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
    else if (mime === 'image/webp') ext = 'webp';
    else ext = 'png';
  }
  const buffer = Buffer.from(data, 'base64');
  const filename = `image-${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`;
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, buffer);
  return `/out/${filename}`;
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/out', express.static(OUT_DIR));

async function postJsonToProvider(url, apiKey, bodyObj) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(bodyObj),
    timeout: 60000
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text, json };
}

/**
 * postFormToProvider sends both text_prompts (JSON) and a fallback 'prompt'
 * field so endpoints that expect prompt in multipart/form-data accept it.
 */
async function postFormToProvider(url, apiKey, bodyObj) {
  const form = new FormData();

  // include structured and plain prompt variants
  if (bodyObj.text_prompts) {
    form.append('text_prompts', JSON.stringify(bodyObj.text_prompts));
    try {
      const p0 = Array.isArray(bodyObj.text_prompts) && bodyObj.text_prompts[0] && bodyObj.text_prompts[0].text
        ? bodyObj.text_prompts[0].text
        : JSON.stringify(bodyObj.text_prompts);
      form.append('prompt', p0);
    } catch (e) { /* noop */ }
  } else if (bodyObj.prompt) {
    form.append('prompt', String(bodyObj.prompt));
  }

  if (bodyObj.width) form.append('width', String(bodyObj.width));
  if (bodyObj.height) form.append('height', String(bodyObj.height));
  if (bodyObj.samples) form.append('samples', String(bodyObj.samples));
  if (bodyObj.model) form.append('model', bodyObj.model);

  const headers = form.getHeaders();
  headers['Authorization'] = `Bearer ${apiKey}`;
  headers['Accept'] = 'application/json';

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    timeout: 60000
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { ok: resp.ok, status: resp.status, statusText: resp.statusText, text, json };
}

app.post('/api/generate-image', async (req, res) => {
  try {
    const prompt = (req.body.prompt || '').trim();
    const width = parseInt(req.body.width || process.env.DEFAULT_WIDTH || '512', 10);
    const height = parseInt(req.body.height || process.env.DEFAULT_HEIGHT || '512', 10);
    const samples = parseInt(req.body.samples || '1', 10);

    if (!prompt || prompt.length < 3) return res.status(400).json({ error: 'Prompt too short' });
    if (!API_KEY) return res.status(500).json({ error: 'Server not configured with PROVIDER_API_KEY' });

    const payload = {
      text_prompts: [{ text: prompt }],
      width,
      height,
      samples
    };

    // 1) Try JSON
    const jsonAttempt = await postJsonToProvider(IMAGE_API_URL, API_KEY, payload);
    if (jsonAttempt.ok) {
      const pdata = jsonAttempt.json || null;
      const b64 = (pdata && pdata.artifacts && pdata.artifacts[0] && pdata.artifacts[0].base64) ||
                  (pdata && pdata.image_base64) || null;
      if (b64) {
        const savedPath = saveBase64ImageToOut(b64);
        return res.json({ imageUrl: savedPath, providerResponse: pdata });
      }
      const imageUrl = (pdata && pdata.output && pdata.output[0] && pdata.output[0].url) ||
                       (pdata && pdata.image_url) || null;
      if (imageUrl) {
        try {
          const dResp = await fetch(imageUrl);
          if (dResp.ok) {
            const buffer = await dResp.buffer();
            const filename = `image-${Date.now()}-${Math.floor(Math.random()*10000)}.png`;
            fs.writeFileSync(path.join(OUT_DIR, filename), buffer);
            return res.json({ imageUrl: `/out/${filename}`, providerResponse: pdata });
          } else {
            return res.json({ imageUrl: imageUrl, providerResponse: pdata });
          }
        } catch (e) {
          return res.json({ imageUrl: imageUrl, providerResponse: pdata });
        }
      }
      return res.status(500).json({ error: 'No image returned in provider JSON', payload: pdata });
    }

    // 2) JSON failed — check reason and retry with form-data if appropriate
    const lowerText = (jsonAttempt.text || '').toLowerCase();
    if (jsonAttempt.status === 400 || lowerText.includes('multipart') || lowerText.includes('content-type') || lowerText.includes('accept') || lowerText.includes('prompt: required')) {
      const formAttempt = await postFormToProvider(IMAGE_API_URL, API_KEY, payload);
      if (formAttempt.ok) {
        const pdata = formAttempt.json || null;
        const b64 = (pdata && pdata.artifacts && pdata.artifacts[0] && pdata.artifacts[0].base64) ||
                    (pdata && pdata.image_base64) || null;
        if (b64) {
          const savedPath = saveBase64ImageToOut(b64);
          return res.json({ imageUrl: savedPath, providerResponse: pdata });
        }
        const imageUrl = (pdata && pdata.output && pdata.output[0] && pdata.output[0].url) ||
                         (pdata && pdata.image_url) || null;
        if (imageUrl) {
          try {
            const dResp = await fetch(imageUrl);
            if (dResp.ok) {
              const buffer = await dResp.buffer();
              const filename = `image-${Date.now()}-${Math.floor(Math.random()*10000)}.png`;
              fs.writeFileSync(path.join(OUT_DIR, filename), buffer);
              return res.json({ imageUrl: `/out/${filename}`, providerResponse: pdata });
            } else {
              return res.json({ imageUrl: imageUrl, providerResponse: pdata });
            }
          } catch (e) {
            return res.json({ imageUrl: imageUrl, providerResponse: pdata });
          }
        }
        return res.status(500).json({ error: 'No image returned in provider form response', payload: pdata });
      } else {
        return res.status(502).json({
          error: `Provider initial error (json ${jsonAttempt.status}) and form-data retry (status ${formAttempt.status})`,
          jsonAttempt: { status: jsonAttempt.status, text: jsonAttempt.text },
          formAttempt: { status: formAttempt.status, text: formAttempt.text }
        });
      }
    }

    return res.status(502).json({
      error: `Provider initial error: ${jsonAttempt.status} ${jsonAttempt.statusText}`,
      details: jsonAttempt.text
    });

  } catch (err) {
    console.error('Server error (generate-image):', err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Image API URL: ${IMAGE_API_URL}`);
});
s
