// server.js
import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import axios from 'axios';
import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { PaidSession } from './models/paid_queue.js';
import { Checkout } from './models/checkout.js'; 
import progressRouter from './routes/progress.js';

// ✅ Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const app = express();
app.use(express.json());
app.use('/api', progressRouter);

// In‑memory checkout store (optional fallback, can remove once you rely only on Mongo)
const checkoutStore = new Map();
function storeCheckout(checkoutId, payload, ttlMs = 1000 * 60 * 30) {
  checkoutStore.set(checkoutId, { payload, expiresAt: Date.now() + ttlMs });
  setTimeout(() => checkoutStore.delete(checkoutId), ttlMs + 1000);
}

// Static file serving
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

async function getUserActiveSession(userId) {
  try {
    const session = await PaidSession.findOne({ active: true, userId });
    if (!session) return null;

    // Normalize tracks for consistency
    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
    session.tracks = session.tracks.map(t => ({
      uri: normalizeUri(t.uri),
      title: t.title,
      artist: t.artist,
      albumArt: t.albumArt,
      duration_ms: t.durationMs || 0,
      status: t.status || (t.played ? 'Played' : 'Added')
    }));

    return session;
  } catch (err) {
    console.error('getUserActiveSession error:', err);
    return null;
  }
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
let playedQueue = [];

async function startPaidSession(sessionId, tracks, estimatedTotalMs = null, userId = null) {
  // Scope lookup by sessionId + userId
  let session = await PaidSession.findOne({ sessionId, userId });
  if (!session) throw new Error('Session not found');

  if (session.active) {
    // Append mode with deduplication
    for (const track of tracks) {
      if (!session.tracks.some(t => t.uri === track.uri)) {
        session.tracks.push(normalizeTrack(track, session.tracks.length + 1));
        session.songsAdded++;
      }
    }
    await session.save();

    // Queue only new tracks in Spotify
    await refreshAccessTokenIfNeeded();
    for (const track of tracks) {
      const alreadyQueued = session.tracks.some(t => t.uri === track.uri && t.played);
      if (!alreadyQueued) {
        const queueUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`;
        const qRes = await fetch(queueUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (!qRes.ok) {
          console.warn('Spotify queue failed', track.uri, await qRes.text());
        }
      }
    }

    return { added: true };
  }

  // Replace mode: first start
  session.active = true;
  session.tracks = tracks.map((track, i) => normalizeTrack(track, i + 1));
  session.songsAdded = tracks.length;
  await session.save();

  try {
    await refreshAccessTokenIfNeeded();
    const r = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris: tracks.map(t => t.uri) })
    });
    if (r.status !== 204) {
      console.warn('spotify play returned', r.status, await r.text());
    }
  } catch (err) {
    console.error('startPaidSession play error', err);
  }

  if (!estimatedTotalMs) {
    const perTrackMs = 3.5 * 60 * 1000;
    estimatedTotalMs = tracks.length * perTrackMs;
  }

  // Cleanup scoped to this session only
  setTimeout(async () => {
    const freshSession = await PaidSession.findOne({ sessionId, userId });
    if (!freshSession) return;

    const remaining = freshSession.tracks.filter(t => !t.played);
    if (remaining.length === 0) {
      freshSession.active = false;
      freshSession.endedAt = new Date();
      await freshSession.save();

      try {
        await refreshAccessTokenIfNeeded();
        const defaultPlaylistUri = process.env.DEFAULT_PLAYLIST_URI || null;
        const body = defaultPlaylistUri ? { context_uri: defaultPlaylistUri } : {};
        await fetch('https://api.spotify.com/v1/me/player/play', {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        console.warn('Error resuming default playlist after paid session', err);
      }
    }
  }, estimatedTotalMs + 2000);
}


// Helper: normalize incoming track shape
function normalizeTrack(track, orderIndex, currentUri, isPlaying) {
  let status = 'Added';
  if (track.played) {
    status = 'Played';
  } else if (currentUri && track.uri === currentUri) {
    status = isPlaying ? 'Playing' : 'Paused';
  }

  return {
    uri: track.uri,
    title: track.title || track.name || '',
    artist: track.artist || (track.artists && track.artists.join(', ')) || '',
    durationMs: track.duration_ms || track.durationMs || 0,   // ✅ unified
    albumArt: track.albumArt || track.album_art || '',
    addedAt: track.addedAt ? new Date(track.addedAt) : new Date(),
    played: !!track.played,
    orderIndex: orderIndex || 0,
    status
  };
}





app.post('/api/play', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();

    const { tracks = [], device_id, sessionId, checkoutId, userId, append } = req.body || {};
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing tracks array' });
    }

    // ✅ Always use full checkoutId consistently
    const effectiveCheckoutId = checkoutId || sessionId || crypto.randomUUID();

    // 1) Idempotency by checkoutId
    if (effectiveCheckoutId && !append) {
      const existing = await PaidSession.findOne({ checkoutId: effectiveCheckoutId });
      if (existing) {
        return res.json({
          success: true,
          mode: existing.active ? 'already-active' : 'existing-session',
          sessionId: existing.sessionId,
          message: 'Checkout already processed; attach to existing session'
        });
      }
    }

    // 2) Try to find by sessionId or checkoutId
    let session = null;
    if (sessionId) {
      session = await PaidSession.findOne({ sessionId });
    }
    if (!session && effectiveCheckoutId) {
      session = await PaidSession.findOne({ checkoutId: effectiveCheckoutId });
    }

    // 3) If no session found, create new
    if (!session) {
      const newSessionId = sessionId || `${effectiveCheckoutId}-${Date.now()}`;
      session = new PaidSession({
        sessionId: newSessionId,
        userId: userId || null,
        checkoutId: effectiveCheckoutId,   // ✅ full UUID only
        packagePrice: 0,
        maxSongs: 0,
        songsAdded: 0,
        active: false,
        startedAt: new Date(),
        tracks: []
      });
    }

    // 4) Append mode
    if (append) {
      const existingUris = new Set(session.tracks.map(t => t.uri));
      const toAdd = [];
      let nextIndex = session.tracks.length + 1;

      for (const t of tracks) {
        if (!t || !t.uri) continue;
        if (existingUris.has(t.uri)) continue;
        const nt = normalizeTrack(t, nextIndex++);
        toAdd.push(nt);
        existingUris.add(nt.uri);
      }

      if (toAdd.length > 0) {
        session.tracks = session.tracks.concat(toAdd);
        session.songsAdded = (session.songsAdded || 0) + toAdd.length;
        await session.save();
      }

      // Queue tracks on Spotify
      for (const track of toAdd) {
        try {
          const queueUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}${device_id ? `&device_id=${encodeURIComponent(device_id)}` : ''}`;
          const qRes = await fetch(queueUrl, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } });
          if (!qRes.ok) {
            const txt = await qRes.text().catch(() => '<no body>');
            console.warn('Spotify queue failed', track.uri, qRes.status, txt);
          }
        } catch (e) {
          console.warn('Spotify queue error', track.uri, e);
        }
      }

      return res.json({ success: true, mode: 'append', sessionId: session.sessionId, added: toAdd.length });
    }

    // 5) Replace mode
    if (session.active) {
      return res.json({ success: true, mode: 'already-active', sessionId: session.sessionId });
    }

    // 6) Replace logic
    const seen = new Set();
    const normalized = [];
    let idx = 1;
    for (const t of tracks) {
      if (!t || !t.uri) continue;
      if (seen.has(t.uri)) continue;
      seen.add(t.uri);
      normalized.push(normalizeTrack(t, idx++));
    }

    session.tracks = normalized;
    session.songsAdded = normalized.length;
    session.active = true;
    session.startedAt = session.startedAt || new Date();
    await session.save();

    // 7) Attempt to start playback
    try {
      const playUrl = `https://api.spotify.com/v1/me/player/play${device_id ? `?device_id=${encodeURIComponent(device_id)}` : ''}`;
      const playR = await fetch(playUrl, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: normalized.map(t => t.uri) })
      });

      if (!playR.ok) {
        const text = await playR.text().catch(() => '<no body>');
        session.active = false;
        await session.save();
        return res.status(playR.status).json({ success: false, error: 'play failed', details: text });
      }

      // Mark playback started
      session.playbackStartedAt = new Date();
      if (normalized.length > 0) {
        session.currentUri = normalized[0].uri;
        session.isPlaying = true;
      }
      await session.save();

    } catch (e) {
      session.active = false;
      await session.save();
      console.error('Spotify play error', e);
      return res.status(500).json({ success: false, error: 'play failed', details: e.message });
    }

    // 8) Success
    return res.json({ success: true, mode: 'replace', sessionId: session.sessionId });

  } catch (err) {
    console.error('/api/play error', err);
    return res.status(500).json({ success: false, error: 'play failed', details: err.message });
  }
});

// Mark a track as played in the given session
async function markTrackPlayed(sessionId, uri, userId = null) {
  try {
    // Scope lookup by sessionId + userId
    const query = userId ? { sessionId, userId } : { sessionId };
    const session = await PaidSession.findOne(query);
    if (!session) return;

    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
    const track = session.tracks.find(t => normalizeUri(t.uri) === normalizeUri(uri) && !t.played);

    if (track) {
      track.played = true;
      track.status = 'Played';   // ✅ update status field

      // Check if all tracks are played
      const allPlayed = session.tracks.every(t => t.played);
      if (allPlayed) {
        session.active = false;
        session.endedAt = new Date();
      }

      await session.save();
      console.log(`[markTrackPlayed] Marked track as played: ${uri} in session ${sessionId}`);
    }
  } catch (err) {
    console.error('markTrackPlayed error:', err);
  }
}



app.get('/api/status', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();

    const { checkoutId } = req.query;
    let activeSession;

    if (checkoutId) {
      activeSession = await PaidSession.findOne({ checkoutId, active: true });
    } else {
      activeSession = await PaidSession.findOne({ active: true });
    }

    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('Retry-After') || '5', 10);
      return res.status(429).json({ success: false, error: 'Rate limited', retryAfter });
    }

    if (r.status === 204) {
      return res.json({
        success: true,
        status: activeSession?.processed ? 'successful' : 'pending',
        mode: activeSession ? 'PAID' : 'DEFAULT',
        sessionId: activeSession?.sessionId || null,
        checkoutId: activeSession?.checkoutId || null,
        playedCount: activeSession ? (activeSession.tracks || []).filter(t => t.status === 'Played').length : 0,
        totalTracks: activeSession?.tracks?.length || 0,
        tracks: activeSession?.tracks?.filter(t => t.addedAt >= activeSession.startedAt) || [],
        isPlaying: false
      });
    }

    if (!r.ok) {
      const text = await r.text().catch(() => '<no body>');
      return res.status(r.status).json({ success: false, error: 'Spotify status failed', details: text });
    }

    const data = await r.json();
    let tracks = activeSession?.tracks || [];

    if (activeSession) {
      const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
      const currentUri = normalizeUri(data.item?.uri);
      const progressMs = data.progress_ms || 0;
      const durationMs = data.item?.duration_ms || 0;

      // Mark as played if finished
      if (currentUri && durationMs > 0 && progressMs >= durationMs - 2000) {
        const track = activeSession.tracks.find(t => normalizeUri(t.uri) === currentUri);
        if (track && !track.played) {
          track.played = true;
          track.status = 'Played';
        }
      }

      // Update playback state + track statuses
      activeSession.currentUri = currentUri || null;
      activeSession.isPlaying = data.is_playing || false;

      activeSession.tracks.forEach(t => {
        const trackUri = normalizeUri(t.uri);
        if (t.played) {
          t.status = 'Played';
        } else if (currentUri && trackUri === currentUri) {
          t.status = data.is_playing ? 'Playing' : 'Paused';
        } else {
          t.status = 'Added';
        }
      });

      await activeSession.save();

      // ✅ Only include tracks from this session
      tracks = activeSession.tracks
        .filter(t => t.addedAt >= activeSession.startedAt)
        .map(t => ({
          uri: normalizeUri(t.uri),
          title: t.title || 'Unknown',
          artist: t.artist || '',
          albumArt: t.albumArt,
          duration_ms: t.duration_ms || 0,
          status: t.status
        }));
    }

    const playedCount = tracks.filter(t => t.status === 'Played').length;

const responsePayload = {
  success: true,
  status: activeSession?.processed ? 'successful' : 'pending',
  mode: activeSession ? 'PAID' : 'DEFAULT',
  sessionId: activeSession?.sessionId || null,
  checkoutId: activeSession?.checkoutId || null,
  playedCount,
  totalTracks: tracks.length,
  tracks,
  title: data.item?.name || 'Unknown',
  artist: data.item?.artists?.map(a => a.name).join(', ') || '',
  albumArt: data.item?.album?.images?.[0]?.url || '',
  uri: data.item?.uri || null,
  isPlaying: data.is_playing || false,
  progressMs: data.progress_ms || 0,
  durationMs: data.item?.duration_ms || 0,

  // ✅ New field: all URIs already persisted in this session
  enaddedUris: activeSession ? activeSession.tracks.map(t => t.uri) : []
};


    // Cleanup logic: delete when all tracks are played and nothing is playing
    if (activeSession) {
      const allPlayed = tracks.length > 0 && tracks.every(t => t.status === 'Played');
      if (allPlayed && !activeSession.isPlaying) {
        activeSession.active = false;
        activeSession.endedAt = new Date();
        await PaidSession.deleteOne({ _id: activeSession._id });
        console.log(`[CLEANUP] Deleted finished session: ${activeSession._id}`);
      }
    }

    return res.json(responsePayload);
  } catch (err) {
    res.status(500).json({ success: false, error: 'status failed', details: err.message });
  }
});

// Reserve tracks
app.post('/api/reserve-tracks', async (req, res) => {
  try {
    const tracks = req.body.tracks;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0)
      return res.status(400).json({ error: 'tracks required' });

    paidQueue.push(...tracks.map(t => ({ uri: t.uri, duration_ms: t.duration_ms || 0 })));
    return res.json({ success: true, added: tracks.length });
  } catch (err) {
    console.error('/api/reserve-tracks error', err);
    res.status(500).json({ error: 'reserve failed' });
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
      duration_ms: t.duration_ms || 0,
      albumArt: t.album?.images?.[0]?.url || null
    }));

    res.json(tracks);
  } catch (err) {
    console.error('/api/search error', err);
    res.status(500).json({ error: 'Spotify search failed', message: err.message });
  }
});

// =========================
// Get full session details
// =========================
app.get('/api/session/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Find the PaidSession by sessionId
    const session = await PaidSession.findOne({ sessionId: id });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Find the linked Checkout by checkoutId
    const checkout = await Checkout.findOne({ checkoutId: session.checkoutId });

    // Format response
    const response = {
      sessionId: session.sessionId,
      userId: session.userId,
      checkoutId: session.checkoutId,
      packagePrice: session.packagePrice,
      maxSongs: session.maxSongs,
      songsAdded: session.songsAdded,
      active: session.active,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      tracks: session.tracks.map(track => ({
        uri: track.uri,
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
        albumArt: track.albumArt,
        addedAt: track.addedAt,
        played: track.played,
        orderIndex: track.orderIndex
      })),
      checkout: checkout
        ? {
            amount: checkout.amount,
            currency: checkout.currency,
            description: checkout.description,
            createdAt: checkout.createdAt,
            expiresAt: checkout.expiresAt
          }
        : null
    };

    res.json(response);
  } catch (err) {
    console.error('/api/session/:id error', err);
    res.status(500).json({ error: 'Failed to fetch session', details: err.message });
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
    const { amount, currency = 'ZAR', description = 'Musicbox Paid Session', tracks = [], userId } = req.body;

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
      successUrl: `https://mymusicbox.onrender.com/index.html?checkoutId=${checkoutId}`,
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

    // ✅ Upsert checkout to avoid duplicates
    await Checkout.findOneAndUpdate(
      { checkoutId },
      {
        $setOnInsert: {
          checkoutId,
          tracks,
          amount,
          currency,
          description,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000)
        }
      },
      { upsert: true, new: true }
    );

    // ✅ Atomic PaidSession creation (idempotent)
    const sessionId = `${Date.now()}-${checkoutId}`;
    const session = await PaidSession.findOneAndUpdate(
      { checkoutId, userId },
      {
        $setOnInsert: {
          sessionId,
          userId,
          checkoutId,
          packagePrice: amount,
          maxSongs: tracks.length,
          songsAdded: 0,
          active: false,
          startedAt: new Date(),
          tracks: tracks.map((track, i) => normalizeTrack(track, i + 1))
        }
      },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      checkoutUrl: response.data.redirectUrl,
      checkoutId,
      sessionId: session.sessionId
    });
  } catch (err) {
    console.error('/api/create-payment error', err.response?.status, err.response?.data || err.message);
    const message = err.response?.data || err.message || 'Checkout creation failed';
    return res.status(500).json({ success: false, error: message });
  }
});

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
        successUrl: `https://mymusicbox.onrender.com/index.html?checkoutId=${checkoutId}`,
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


app.get('/api/checkout-tracks', async (req, res) => {
  try {
    const id = req.query.checkoutId;
    if (!id) return res.status(400).json({ error: 'checkoutId required' });

    const entry = await Checkout.findOne({ checkoutId: id }).lean();
    if (!entry) return res.status(404).json({ error: 'checkout not found or expired' });

    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);

    let tracksWithStatus = (entry.tracks || []).map((track, i) => ({
      uri: normalizeUri(track.uri),
      title: track.title,
      artist: track.artist,
      albumArt: track.albumArt,
      duration_ms: track.duration_ms || 0,
      order: i + 1,
      status: 'Added'
    }));

    const session = await PaidSession.findOne({ checkoutId: id }).lean();
    if (session) {
      const currentUri = normalizeUri(session.currentUri);
      tracksWithStatus = session.tracks.map(t => {
        const trackUri = normalizeUri(t.uri);
        let status = 'Added';
        if (t.played) status = 'Played';
        else if (currentUri && trackUri === currentUri) status = session.isPlaying ? 'Playing' : 'Paused';
        return {
          uri: trackUri,
          title: t.title,
          artist: t.artist,
          albumArt: t.albumArt,
          duration_ms: t.durationMs || 0,
          status
        };
      });
    }

    // ✅ Deduplicate by URI before returning
    const seen = new Set();
    tracksWithStatus = tracksWithStatus.filter(t => {
      if (seen.has(t.uri)) return false;
      seen.add(t.uri);
      return true;
    });

    res.json({
      success: true,
      checkoutId: id,
      mode: session ? 'PAID' : 'DEFAULT',
      totalTracks: tracksWithStatus.length,
      tracks: tracksWithStatus
    });
  } catch (err) {
    console.error('/api/checkout-tracks error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

app.post('/webhook/payment-success', async (req, res) => {
  try {
    const { sessionId, checkoutId, tracks = [], userId } = req.body;
    if (!checkoutId) {
      return res.status(400).json({ error: 'Missing checkoutId' });
    }

    const effectiveCheckoutId = checkoutId;
    const estimatedTotalMs = tracks.reduce((s, t) => s + (t.duration_ms || 210000), 0);

    // ✅ Attach to existing session by checkoutId
    let session = await PaidSession.findOne({ checkoutId: effectiveCheckoutId });
    if (!session) {
      return res.status(404).json({ error: 'No session found for checkoutId' });
    }

    // Guard: skip duplicate webhook
    if (session.songsAdded > 0 && session.playbackStartedAt) {
      return res.json({ ok: true, message: 'Session already processed, skipping duplicate webhook' });
    }

    if (tracks.length > 0) {
      session.tracks = tracks.map((track, i) => normalizeTrack(track, i + 1));
      session.songsAdded = tracks.length;
      session.active = true;
      await session.save();

      try {
        await startPaidSession(session.sessionId, tracks, estimatedTotalMs);
        session.playbackStartedAt = new Date();
        await session.save();
      } catch (err) {
        console.error('startPaidSession error', err);
        return res.status(500).json({ error: 'playback failed', details: err.message });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('/webhook/payment-success error', err);
    res.status(500).json({ error: 'webhook handling failed', details: err.message });
  }
});

async function isPaidSessionActive() {
  try {
    const activeSession = await PaidSession.findOne({ active: true });
    return activeSession || null;
  } catch (err) {
    console.error('isPaidSessionActive error:', err);
    return null;
  }
}



app.post('/api/queue', async (req, res) => {
  try {
    await refreshAccessTokenIfNeeded();

    const { uri, checkoutId, userId, title, artist, duration_ms, albumArt, device_id } = req.body || {};
    if (!uri || !checkoutId) {
      return res.status(400).json({ error: 'Missing track URI or checkoutId' });
    }

    // Ensure shuffle is off
    await fetch('https://api.spotify.com/v1/me/player/shuffle?state=false', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    const queueUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}${device_id ? `&device_id=${encodeURIComponent(device_id)}` : ''}`;
    const r = await fetch(queueUrl, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } });

    if (!r.ok) {
      const text = await r.text();
      console.error('/api/queue failed', r.status, text);
      if (r.status === 404 && text.includes('NO_ACTIVE_DEVICE')) {
        return res.status(404).json({ error: 'No active Spotify device found. Please open the Spotify app and start playback once.', details: text });
      }
      return res.status(r.status).json({ error: 'Spotify queue request failed', details: text });
    }

    let session = await PaidSession.findOne({ checkoutId });
    if (!session) return res.status(404).json({ error: 'No active session for checkoutId' });

    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
    const normalizedUri = normalizeUri(uri);

    // ✅ Deduplicate: only add if not already present
    if (!session.tracks.some(t => normalizeUri(t.uri) === normalizedUri)) {
      const orderIndex = session.tracks.length + 1;
      session.tracks.push(normalizeTrack({ uri, title, artist, duration_ms, albumArt }, orderIndex));
      session.songsAdded += 1;
      await session.save();
    }

    res.json({ ok: true, checkoutId, added: normalizedUri });
  } catch (err) {
    console.error('/api/queue error', err);
    res.status(500).json({ error: 'Queue request failed', details: err.message });
  }
});


// Poller: update played tracks every 5 seconds
setInterval(async () => {
  const activeSession = await isPaidSessionActive();
  if (!activeSession) return;

  try {
    await refreshAccessTokenIfNeeded();
    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    // Handle 204 (no content)
    if (r.status === 204) {
      return; // nothing playing
    }

    // Handle non-OK responses
    if (!r.ok) {
      const text = await r.text().catch(() => '<no body>');
      console.warn(`Spotify status failed ${r.status}: ${text}`);
      return;
    }

    // Defensive JSON parse
    let data = null;
    try {
      const text = await r.text();
      if (text && text.trim().length > 0) {
        data = JSON.parse(text);
      }
    } catch (err) {
      console.warn('Spotify returned empty or invalid JSON', err);
      return;
    }

    // If we got valid data, mark track played
    if (data?.item?.uri) {
      await markTrackPlayed(activeSession.sessionId, data.item.uri);
    }
  } catch (err) {
    console.error('Poller error:', err);
  }
}, 5000); // every 5 seconds


/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});