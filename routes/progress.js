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

    // ✅ Find by checkoutId (same as webhook)
    const session = await PaidSession.findOne({ checkoutId });
    if (!session) {
      return res.json({ success: false, message: 'Session not found' });
    }

    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
    const currentUriNorm = normalizeUri(session.currentUri);

    const tracksWithStatus = session.tracks.map(t => {
      const trackUri = normalizeUri(t.uri);
      let status = 'Added';

      if (t.played) {
        status = 'Played';
      } else if (currentUriNorm && trackUri === currentUriNorm) {
        status = session.isPlaying ? 'Playing' : 'Paused';
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

    // ✅ Cleanup logic: delete by _id
    const allPlayed = tracksWithStatus.length > 0 &&
      tracksWithStatus.every(t => t.status === 'Played');

    if (allPlayed && !session.isPlaying) {
      session.active = false;
      session.endedAt = new Date();
      await PaidSession.deleteOne({ _id: session._id });
      console.log(`[CLEANUP] Deleted finished session: ${session._id}`);
    }

    return res.json(responsePayload);
  } catch (err) {
    console.error('Error in /api/progress:', err);
    return res.json({ success: false, message: 'Internal server error' });
  }
});

export default router;
