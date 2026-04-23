// routes/progress.js
import express from 'express';
import { PaidSession } from '../models/paid_queue.js';

const router = express.Router();

router.get('/progress', async (req, res) => {
  try {
    const { checkoutId } = req.query;
    if (!checkoutId) {
      return res.json({ success: false, message: 'Missing checkoutId' });
    }

    // ✅ Lookup by checkoutId
    const session = await PaidSession.findOne({ checkoutId });
    if (!session) {
      return res.json({ success: false, message: 'Session not found' });
    }

    const isPlaying = session.isPlaying;

    // Normalize URIs
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

    console.log('Progress route statuses:', tracksWithStatus.map(t => ({
      uri: t.uri,
      title: t.title,
      status: t.status
    })));

    const playingTrack = tracksWithStatus.find(t => t.status === 'Playing');

    const responsePayload = {
      success: true,
      sessionId: session.sessionId,
      checkoutId: session.checkoutId,
      userId: session.userId,
      title: playingTrack?.title || null,
      artist: playingTrack?.artist || null,
      albumArt: playingTrack?.albumArt || null,
      mode: session.active ? 'PAID' : 'DEFAULT',
      playedCount: tracksWithStatus.filter(t => t.status === 'Played').length,
      totalTracks: tracksWithStatus.length,
      tracks: tracksWithStatus
    };

    // ✅ Delete only when all tracks are played and nothing is currently playing
    const allPlayed = tracksWithStatus.length > 0 &&
      tracksWithStatus.every(t => t.status === 'Played');

    if (allPlayed && !playingTrack) {
      await PaidSession.deleteOne({ checkoutId: session.checkoutId });
      console.log(`[PROGRESS] Deleted finished session: ${session.checkoutId}`);
    }

    res.json(responsePayload);
  } catch (err) {
    console.error('Error in /api/progress:', err);
    res.json({ success: false, message: 'Internal server error' });
  }
});

export default router;
