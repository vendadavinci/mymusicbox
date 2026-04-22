// routes/progress.js
import express from 'express';
import { PaidSession } from '../models/paid_queue.js';

const router = express.Router();

router.get('/progress', async (req, res) => {
  try {
    const { sessionId, checkoutId } = req.query;

    if (!sessionId && !checkoutId) {
      return res.json({ success: false, message: 'Missing sessionId or checkoutId' });
    }

    // ✅ Try to find by sessionId first, then fallback to checkoutId
    let session = null;
    if (sessionId) {
      session = await PaidSession.findOne({ sessionId });
    }
    if (!session && checkoutId) {
      session = await PaidSession.findOne({ checkoutId });
    }

    if (!session) {
      return res.json({ success: false, message: 'Session not found' });
    }

    const isPlaying = session.isPlaying;

    const normalizeUri = u => {
      if (!u) return null;
      return u.startsWith('spotify:track:') ? u : `spotify:track:${u}`;
    };

    const currentUriNorm = normalizeUri(session.currentUri);

    const tracksWithStatus = session.tracks.map(t => {
      const trackUri = normalizeUri(t.uri);
      let status = 'Added';

      if (t.played) {
        status = 'Played';
      } else if (currentUriNorm && trackUri === currentUriNorm) {
        status = isPlaying ? 'Playing' : 'Paused';
      }

      return {
        uri: trackUri,
        title: t.title,
        artist: t.artist,
        albumArt: t.albumArt,
        duration_ms: t.durationMs || 0,
        status
      };
    });

    const playingTrack = tracksWithStatus.find(t => t.status === 'Playing');

    const playedCount = tracksWithStatus.filter(
      t => t.status === 'Played' || t.status === 'Playing'
    ).length;

    res.json({
      success: true,
      sessionId: session.sessionId,
      checkoutId: session.checkoutId,
      title: playingTrack?.title || null,
      artist: playingTrack?.artist || null,
      albumArt: playingTrack?.albumArt || null,
      mode: session.active ? 'PAID' : 'DEFAULT',
      playedCount,
      totalTracks: tracksWithStatus.length,
      tracks: tracksWithStatus
    });
  } catch (err) {
    console.error('Error in /api/progress:', err);
    res.json({ success: false, message: 'Internal server error' });
  }
});

export default router;
