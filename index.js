// server/index.js
const express = require('express');
const fetch = require('node-fetch'); // v2
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));

// Allow CORS from frontend origin if provided, otherwise allow all (dev).
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

const PORT = process.env.PORT || 4000;

const VIDEO_API_URL = process.env.PROVIDER_VIDEO_API_URL || 'https://api.stability.ai/v2beta/video/generate';
const VIDEO_STATUS_URL_TEMPLATE = process.env.PROVIDER_VIDEO_STATUS_URL || 'https://api.stability.ai/v2beta/video/status/{jobId}';
const API_KEY = process.env.PROVIDER_API_KEY || ''; // set in Render env vars

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const MAX_POLL_MS = parseInt(process.env.MAX_POLL_MS || '300000', 10); // 5 minutes default

// In-memory job store (for demo / simple deploy). For production use DB.
const jobs = new Map();

// Helper: build status URL for provider polling
function buildStatusUrl(jobId) {
  return VIDEO_STATUS_URL_TEMPLATE.replace('{jobId}', jobId);
}

// Helper: save base64 or remote file to local out and return local url path
async function saveVideoFromBase64OrUrl({ base64, remoteUrl }) {
  if (base64) {
    const buffer = Buffer.from(base64, 'base64');
    const filename = `video-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
    const outPath = path.join(OUT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    return `/out/${filename}`;
  }
  if (remoteUrl) {
    // try to download remoteUrl to local
    try {
      const resp = await fetch(remoteUrl);
      if (!resp.ok) throw new Error(`Failed to download remote video: ${resp.status}`);
      const buffer = await resp.buffer();
      const filename = `video-${Date.now()}-${Math.floor(Math.random()*1000)}.mp4`;
      const outPath = path.join(OUT_DIR, filename);
      fs.writeFileSync(outPath, buffer);
      return `/out/${filename}`;
    } catch (err) {
      console.warn('download remote video failed', err.message);
      return remoteUrl; // fallback: return remote URL directly
    }
  }
  return null;
}

// Background worker: polls provider status for jobs in 'processing' state
async function pollWorker() {
  for (const [jobId, job] of jobs.entries()) {
    if (job.status !== 'processing') continue;
    // If we already have providerJobId, poll provider. If polling timed out, mark failed.
    const elapsed = Date.now() - job.startedAt;
    if (elapsed > (job.maxPollMs || MAX_POLL_MS)) {
      job.status = 'failed';
      job.error = 'Polling timeout';
      jobs.set(jobId, job);
      continue;
    }

    // Poll provider's status endpoint if we have providerJobId
    const providerJobId = job.providerJobId;
    if (!providerJobId) continue; // cannot poll yet

    const statusUrl = buildStatusUrl(providerJobId);
    try {
      const sResp = await fetch(statusUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${API_KEY}` }
      });
      if (!sResp.ok) {
        const txt = await sResp.text();
        console.warn('Status poll non-ok', sResp.status, txt);
        // do not fail immediately; wait for next poll
        continue;
      }
      const sData = await sResp.json();

      // Common fields: status/state/result.status
      const status = sData.status || sData.state || (sData.result && sData.result.status);
      if (status && (status === 'succeeded' || status === 'completed' || status === 'finished')) {
        // Try to find video URL or base64 in common places
        const vidUrl = sData.video_url || sData.output_url || (sData.result && sData.result.video_url) ||
                       (sData.output && sData.output[0] && sData.output[0].url) ||
                       (sData.data && sData.data[0] && sData.data[0].url);
        const b64 = sData.video_base64 || (sData.output && sData.output[0] && sData.output[0].base64) ||
                    (sData.data && sData.data[0] && sData.data[0].base64);

        const saved = await saveVideoFromBase64OrUrl({ base64: b64, remoteUrl: vidUrl });
        job.status = 'succeeded';
        job.resultUrl = saved || vidUrl || null;
        job.providerResponse = sData;
        jobs.set(jobId, job);
        continue;
      }

      if (status && (status === 'failed' || status === 'error')) {
        job.status = 'failed';
        job.error = sData;
        jobs.set(jobId, job);
        continue;
      }

      // if still processing, update progress if available
      job.lastProviderPayload = sData;
      jobs.set(jobId, job);
    } catch (err) {
      console.warn('Poll worker error', err.message);
      // continue, will try again next tick
    }
  }
}

// Start polling loop
setInterval(pollWorker, POLL_INTERVAL_MS);

// Routes

// health
app.get('/health', (req, res) => res.json({ ok: true }));

// list jobs (debug)
app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.entries()).map(([id, j]) => ({ id, status: j.status, prompt: j.prompt, resultUrl: j.resultUrl }));
  res.json(list);
});

// create new video job (returns jobId immediately)
app.post('/api/generate-video', async (req, res) => {
  try {
    const prompt = (req.body.prompt || '').trim();
    const duration = parseInt(req.body.duration || process.env.DEFAULT_DURATION_SECONDS || '10', 10);
    const width = parseInt(req.body.width || process.env.DEFAULT_WIDTH || '1920', 10);
    const height = parseInt(req.body.height || process.env.DEFAULT_HEIGHT || '1080', 10);

    if (!prompt || prompt.length < 3) {
      return res.status(400).json({ error: 'Prompt too short' });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: 'Server not configured with PROVIDER_API_KEY. Set it in Render environment variables.' });
    }

    // Create job record
    const jobId = uuidv4();
    const job = {
      id: jobId,
      prompt,
      duration,
      width,
      height,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      providerJobId: null,
      resultUrl: null,
      maxPollMs: parseInt(process.env.MAX_POLL_MS || String(MAX_POLL_MS), 10)
    };
    jobs.set(jobId, job);

    // Kick off provider request (do not block the HTTP response)
    (async () => {
      try {
        // mark started
        job.status = 'processing';
        job.startedAt = Date.now();
        jobs.set(jobId, job);

        // Build provider request body — adjust as needed for provider specifics
        const body = {
          prompt,
          duration,
          width,
          height
        };

        const pResp = await fetch(VIDEO_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        if (!pResp.ok) {
          const txt = await pResp.text();
          job.status = 'failed';
          job.error = `Provider initial error: ${pResp.status} ${txt}`;
          jobs.set(jobId, job);
          return;
        }

        const pdata = await pResp.json();

        // If provider returned immediate video link or base64, save and finish
        if (pdata.video_url) {
          const saved = await saveVideoFromBase64OrUrl({ remoteUrl: pdata.video_url });
          job.status = 'succeeded';
          job.resultUrl = saved || pdata.video_url;
          job.providerResponse = pdata;
          jobs.set(jobId, job);
          return;
        }
        if (pdata.video_base64) {
          const saved = await saveVideoFromBase64OrUrl({ base64: pdata.video_base64 });
          job.status = 'succeeded';
          job.resultUrl = saved;
          job.providerResponse = pdata;
          jobs.set(jobId, job);
          return;
        }

        // Otherwise expect a job id to poll later
        const providerJobId = pdata.id || pdata.job_id || pdata.task_id || (pdata.data && pdata.data.id);
        if (providerJobId) {
          job.providerJobId = providerJobId;
          job.providerResponse = pdata;
          jobs.set(jobId, job);
          // worker will poll and update job
          return;
        }

        // Unknown provider response
        job.status = 'failed';
        job.error = { note: 'Unexpected provider response', payload: pdata };
        jobs.set(jobId, job);

      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        jobs.set(jobId, job);
      }
    })();

    // Return job id immediately
    return res.json({ jobId, status: 'queued' });

  } catch (err) {
    console.error('generate-video handler error', err);
    return res.status(500).json({ error: err.message });
  }
});

// get status for job
app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs.has(jobId)) return res.status(404).json({ error: 'Job not found' });
  const job = jobs.get(jobId);
  // return selected fields
  res.json({
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    resultUrl: job.resultUrl,
    error: job.error,
    providerJobId: job.providerJobId,
    providerResponseSummary: job.providerResponse ? (job.providerResponse.id || job.providerResponse.job_id || null) : null
  });
});

// serve generated output files
app.use('/out', express.static(OUT_DIR));

// simple index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Video API URL: ${VIDEO_API_URL}`);
});
