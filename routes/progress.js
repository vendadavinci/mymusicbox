// routes/api/progress.js
import express from 'express';
import { PaidSession } from '../models/paid_queue.js';

const router = express.Router();

router.get('/progress', async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.json({ success: false, message: 'Missing sessionId' });
    }

    const session = await PaidSession.findOne({ sessionId });
    if (!session) {
      return res.json({ success: false, message: 'Session not found' });
    }

    // Determine current playing track (first not yet marked as played)
    const current = session.tracks.find(t => !t.played);

    // Build track list with statuses
    const tracksWithStatus = session.tracks.map(t => {
      let status = 'Queued';
      if (t.played) {
        status = 'Played';
      } else if (current && t.uri === current.uri) {
        status = 'Playing';
      }
      return {
        title: t.title,
        artist: t.artist,
        albumArt: t.albumArt,
        status
      };
    });

    res.json({
      success: true,
      sessionId: session.sessionId,
      title: current?.title || null,
      artist: current?.artist || null,
      albumArt: current?.albumArt || null,
      mode: session.active ? 'PAID' : 'DEFAULT',
      playedCount: session.tracks.filter(t => t.played).length,
      totalTracks: session.tracks.length,
      tracks: tracksWithStatus
    });
  } catch (err) {
    console.error('Error in /api/progress:', err);
    res.json({ success: false, message: 'Internal server error' });
  }
});

export default router;
