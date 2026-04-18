// routes/progress.js
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

    const currentUri = session.currentUri; 
    const isPlaying = session.isPlaying;   

    const tracksWithStatus = session.tracks.map(t => {
      let status = 'Queued';
      if (t.played) {
        status = 'Played';
      } else if (currentUri && t.uri === currentUri) {
        status = isPlaying ? 'Playing' : 'Paused'; 
      }
      return {
        uri: t.uri,
        title: t.title,
        artist: t.artist,
        albumArt: t.albumArt,
        duration_ms: t.durationMs || 0,
        status
      };
    });

    const playingTrack = tracksWithStatus.find(t => t.status === 'Playing');

    res.json({
      success: true,
      sessionId: session.sessionId,
      title: playingTrack?.title || null,
      artist: playingTrack?.artist || null,
      albumArt: playingTrack?.albumArt || null,
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

