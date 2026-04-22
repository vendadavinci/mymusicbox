import express from 'express';
import { Checkout } from '../models/checkout.js';
import { PaidSession } from '../models/paid_queue.js';

const router = express.Router();

router.get('/checkout-tracks', async (req, res) => {
  try {
    const { checkoutId, userId } = req.query;
    if (!checkoutId || !userId) {
      return res.status(400).json({ error: 'checkoutId and userId required' });
    }

    const entry = await Checkout.findOne({ checkoutId, userId });
    if (!entry) {
      return res.status(404).json({ error: 'checkout not found or expired' });
    }

    const normalizedTracks = (entry.tracks || []).map((track, i) => ({
      uri: track.uri,
      title: track.title,
      artist: track.artist,
      albumArt: track.albumArt,
      duration_ms: track.duration_ms || 0,
      order: i + 1
    }));

    const session = await PaidSession.findOne({ checkoutId: checkoutId, userId });
    let tracksWithStatus = normalizedTracks;

    if (session) {
      const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);
      const currentUriNorm = normalizeUri(session.currentUri);

      tracksWithStatus = session.tracks.map(t => {
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
    }

    res.json({
      success: true,
      checkoutId,
      mode: session ? 'PAID' : 'DEFAULT',
      totalTracks: tracksWithStatus.length,
      tracks: tracksWithStatus
    });
  } catch (err) {
    console.error('/api/checkout-tracks error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

export default router;



