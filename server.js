// server.js
import dotenv from 'dotenv';
dotenv.config();
import crypto from 'crypto';
import axios from 'axios';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());


const checkoutStore = new Map(); // { checkoutId -> { tracks, expiresAt } }
function storeCheckout(checkoutId, payload, ttlMs = 1000 * 60 * 30) {
  checkoutStore.set(checkoutId, { payload, expiresAt: Date.now() + ttlMs });
  // schedule cleanup
  setTimeout(() => checkoutStore.delete(checkoutId), ttlMs + 1000);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

let tokens = {
  access_token: null,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || null,
  expires_at: 0
};

if (!tokens.refresh_token) {
  console.warn('Warning: SPOTIFY_REFRESH_TOKEN not set in environment. Visit /auth to obtain one.');
}

async function refreshAccessTokenIfNeeded() {
  if (!tokens.refresh_token) throw new Error('No refresh token stored (set SPOTIFY_REFRESH_TOKEN env or call /auth and save it).');
  // If token still valid for >5s, skip refresh
  if (Date.now() < tokens.expires_at - 5000) return;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        ).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Failed to refresh Spotify token: ${res.status} ${txt}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('Spotify refresh response missing access_token');

  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;

  // If Spotify returned a new refresh_token (rare on refresh), persist it to tokens and log it
  if (data.refresh_token) {
    tokens.refresh_token = data.refresh_token;
    console.log('Spotify returned a new refresh token. Consider updating SPOTIFY_REFRESH_TOKEN in your environment.');
  }
}

let paidSessionActive = false;
let paidSessionTimer = null;
let paidQueue = [];

async function startPaidSession(uris, estimatedTotalMs = null) {
  if (paidSessionActive) {
    paidQueue.push(...uris.map(u => ({ uri: u, duration_ms: 0 })));
    return { queued: true };
  }

  paidSessionActive = true;
  if (paidSessionTimer) {
    clearTimeout(paidSessionTimer);
    paidSessionTimer = null;
  }

  try {
    await refreshAccessTokenIfNeeded();
    const r = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris })
    });
    if (r.status !== 204) {
      console.warn('spotify play returned', r.status, await r.text());
    }
  } catch (err) {
    console.error('startPaidSession play error', err);
  }

  if (!estimatedTotalMs) {
    const perTrackMs = 3.5 * 60 * 1000;
    estimatedTotalMs = uris.length * perTrackMs;
  }

  paidSessionTimer = setTimeout(async () => {
    if (paidQueue.length > 0) {
      const queuedUris = paidQueue.map(i => i.uri);
      paidQueue = [];
      paidSessionTimer = null;
      await startPaidSession(queuedUris, null);
      return;
    }

    paidSessionActive = false;
    paidSessionTimer = null;

    try {
      await refreshAccessTokenIfNeeded();
      const defaultPlaylistUri = process.env.DEFAULT_PLAYLIST_URI || null;
      if (defaultPlaylistUri) {
        await fetch('https://api.spotify.com/v1/me/player/play', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ context_uri: defaultPlaylistUri })
        });
      } else {
        await fetch('https://api.spotify.com/v1/me/player/play', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
      }
    } catch (err) {
      console.warn('Error resuming default playlist after paid session', err);
    }
  }, estimatedTotalMs + 2000);
}

app.post('/api/play', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();

    const { uris, device_id, append } = req.body || {};
    const authHeader = { Authorization: `Bearer ${tokens.access_token}` };

    // Validate input
    if (!Array.isArray(uris) || uris.length === 0) {
      return res.status(400).json({ error: 'Missing uris array' });
    }

    if (append) {
      // Append each URI to the current queue
      for (const uri of uris) {
        const queueUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}${device_id ? `&device_id=${encodeURIComponent(device_id)}` : ''}`;
        const queueR = await fetch(queueUrl, { method: 'POST', headers: authHeader });
        if (!queueR.ok) {
          const txt = await queueR.text().catch(() => '<no body>');
          console.error('/api/play append failed', queueR.status, txt);
          return res.status(queueR.status).json({ error: 'append failed', details: txt });
        }
      }
      return res.json({ ok: true, mode: 'append' });
    }

    // Otherwise: replace playback with provided URIs
    const playUrl = `https://api.spotify.com/v1/me/player/play${device_id ? `?device_id=${encodeURIComponent(device_id)}` : ''}`;
    const playR = await fetch(playUrl, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris })
    });

    if (!playR.ok) {
      const text = await playR.text().catch(() => '<no body>');
      console.error('/api/play failed', playR.status, text);
      return res.status(playR.status).json({ error: 'play failed', details: text });
    }

    return res.json({ ok: true, mode: 'replace' });
  } catch (err) {
    console.error('/api/play error', err);
    return res.status(500).json({ error: 'play failed', details: err.message });
  }
});


// Pause/Resume/Skip protection
app.post('/api/pause', async (req, res) => {
  if (paidSessionActive) return res.status(403).json({ error: 'Cannot pause during paid session' });
  res.json({ ok: true });
});
app.post('/api/resume', async (req, res) => {
  if (paidSessionActive) return res.status(403).json({ error: 'Cannot resume during paid session' });
  res.json({ ok: true });
});
app.post('/api/skip', async (req, res) => {
  if (paidSessionActive) return res.status(403).json({ error: 'Cannot skip during paid session' });
  res.json({ ok: true });
});

// Reserve tracks
app.post('/api/reserve-tracks', async (req, res) => {
  try {
    const tracks = req.body.tracks;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0)
      return res.status(400).json({ error: 'tracks required' });

    paidQueue.push(...tracks.map(t => ({ uri: t.uri, duration_ms: t.duration_ms || 0 })));
    return res.json({ success: true, queued: tracks.length });
  } catch (err) {
    console.error('/api/reserve-tracks error', err);
    res.status(500).json({ error: 'reserve failed' });
  }
});

// Payment webhook
app.post('/webhook/payment-success', async (req, res) => {
  try {
    const session = req.body;
    const tracks = session.tracks || [];
    const uris = tracks.map(t => t.uri);
    const estimatedTotalMs = tracks.reduce((s, t) => s + (t.duration_ms || 210000), 0);
    if (uris.length > 0) {
      await startPaidSession(uris, estimatedTotalMs);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('/webhook/payment-success error', err);
    res.status(500).json({ error: 'webhook handling failed' });
  }
});

// Search
app.post('/api/search', async (req, res) => {
  try {
    const q = req.body.q;
    const limit = req.body.limit || 10;
    if (!q) return res.status(400).json({ error: 'Missing query' });

    await refreshAccessTokenIfNeeded();

    const params = new URLSearchParams({ q, type: 'track', limit: String(limit) });
    const r = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('/api/search spotify returned', r.status, txt);
      return res.status(502).json({ error: 'Spotify search failed', status: r.status, body: txt });
    }

    const data = await r.json();

    const tracks = (data.tracks?.items || []).map(t => ({
      uri: t.uri,
      title: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      duration_ms: t.duration_ms,
      albumArt: t.album?.images?.[0]?.url || null
    }));

    res.json(tracks);
  } catch (err) {
    console.error('/api/search error', err);
    res.status(500).json({ error: 'Spotify search failed', message: err.message });
  }
});

app.get('/auth', (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  const scopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'streaming'
  ].join(' ');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI
  });

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    const data = await r.json();
    console.log('OAuth token response:', data);

    if (data.refresh_token) {
      console.log('*** COPY THIS REFRESH TOKEN TO YOUR RENDER ENV:');
      console.log(data.refresh_token);
      console.log('*** End refresh token');
    }

    tokens.refresh_token = data.refresh_token || tokens.refresh_token;
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;

    res.send('Authorization complete. Check Render logs for your refresh token.');
  } catch (err) {
    console.error('/callback error', err);
    res.status(500).send('Token exchange failed. Check server logs.');
  }
});

app.post('/api/create-payment', async (req, res) => {
  try {
    console.log('/api/create-payment payload:', JSON.stringify(req.body));
    const { amount, currency = 'ZAR', description = 'Musicbox Paid Session', tracks = [] } = req.body;

    if (!process.env.YOCO_SECRET_KEY) {
      console.error('YOCO_SECRET_KEY missing in env');
      return res.status(500).json({ success: false, error: 'Payment provider not configured' });
    }

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const checkoutId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();

    const body = {
      amount,
      currency,
      description,
      successUrl: `https://mymusicbox.onrender.com/jukebox.html?checkoutId=${checkoutId}`,
      cancelUrl: `https://mymusicbox.onrender.com/index.html`
    };

    console.log('Creating Yoco checkout with body:', body);

    const response = await axios.post('https://payments.yoco.com/api/checkouts', body, {
      headers: {
        Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      timeout: 15000
    });

    console.log('Yoco response data:', response.data);

    // store tracks server-side for fallback
    storeCheckout(checkoutId, { tracks, amount, createdAt: Date.now() });

    return res.json({ success: true, checkoutUrl: response.data.redirectUrl, checkoutId });
  } catch (err) {
    console.error('/api/create-payment error:', err.response?.status, err.response?.data || err.message);
    const message = err.response?.data || err.message || 'Checkout creation failed';
    return res.status(500).json({ success: false, error: message });
  }
});



// create checkout route (adapted)

app.post("/api/yoco/create-checkout", async (req, res) => {
  const { amount, currency = "ZAR", description = "Musicbox Paid Session", tracks = [] } = req.body;
  const idempotencyKey = crypto.randomUUID();
  const checkoutId = crypto.randomUUID();

  try {
    const response = await axios.post(
      "https://payments.yoco.com/api/checkouts",
      {
        amount,
        currency,
        description,
        successUrl: `https://mymusicbox.onrender.com/jukebox.html?checkoutId=${checkoutId}`,
        cancelUrl: `https://mymusicbox.onrender.com/index.html`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        }
      }
    );

    // persist tracks server-side keyed by checkoutId
    storeCheckout(checkoutId, { tracks, amount, createdAt: Date.now() });

    res.json({ success: true, checkoutUrl: response.data.redirectUrl, checkoutId });
  } catch (err) {
    console.error("Yoco Checkout API error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data?.error || "Checkout creation failed"
    });
  }
});

// endpoint to fetch stored tracks by checkoutId
app.get('/api/checkout-tracks', (req, res) => {
  const id = req.query.checkoutId;
  if (!id) return res.status(400).json({ error: 'checkoutId required' });
  const entry = checkoutStore.get(id);
  if (!entry) return res.status(404).json({ error: 'checkout not found or expired' });
  return res.json({ success: true, tracks: entry.payload.tracks || [] });
});

app.get('/api/status', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();
    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (r.status === 204) {
      // 204 = no content (nothing playing)
      return res.json({ mode: paidSessionActive ? 'PAID' : 'DEFAULT' });
    }

    if (!r.ok) return res.status(r.status).json({ error: 'Spotify status failed' });

    const data = await r.json();
    res.json({
      mode: paidSessionActive ? 'PAID' : 'DEFAULT',
      title: data.item?.name,
      artist: data.item?.artists?.map(a => a.name).join(', '),
      albumArt: data.item?.album?.images?.[0]?.url
    });
  } catch (err) {
    console.error('/api/status error', err);
    res.status(500).json({ error: 'status failed' });
  }
});

app.post('/api/queue', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();

    const uri = req.query.uri;
    if (!uri) {
      return res.status(400).json({ error: 'Missing track URI' });
    }

    // 🔹 Ensure shuffle is off before adding to queue
    await fetch('https://api.spotify.com/v1/me/player/shuffle?state=false', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    // 🔹 Queue the track
    const r = await fetch(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      }
    );

    if (!r.ok) {
      const text = await r.text();
      console.error('/api/queue failed', r.status, text);

      if (r.status === 404 && text.includes('NO_ACTIVE_DEVICE')) {
        return res.status(404).json({
          error: 'No active Spotify device found. Please open the Spotify app and start playback once.',
          details: text
        });
      }

      return res.status(r.status).json({
        error: 'Spotify queue request failed',
        details: text
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/api/queue error', err);
    res.status(500).json({ error: 'Queue request failed', details: err.message });
  }
});



/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
