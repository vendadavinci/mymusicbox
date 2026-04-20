import express from 'express';
import { Checkout } from '../models/checkout.js';
import { PaidSession } from '../models/paid_queue.js';

const router = express.Router();

router.get('/checkout-tracks', async (req, res) => {
  try {
    const id = req.query.checkoutId;
    if (!id) return res.status(400).json({ error: 'checkoutId required' });

    const entry = await Checkout.findOne({ checkoutId: id });
    if (!entry) return res.status(404).json({ error: 'checkout not found or expired' });

    // Normalize helper
    const normalizeUri = u => (!u ? null : u.startsWith('spotify:track:') ? u : `spotify:track:${u}`);

    const normalizedTracks = (entry.tracks || []).map((track, i) => ({
      uri: normalizeUri(track.uri),
      title: track.title,
      artist: track.artist,
      albumArt: track.albumArt,
      duration_ms: track.duration_ms || track.durationMs || 0,
      order: i + 1,
      status: 'Added'
    }));

    const session = await PaidSession.findOne({ checkoutId: id });
    let tracksWithStatus = normalizedTracks;

    if (session) {
      const currentUriNorm = normalizeUri(session.currentUri);
      const isPlaying = session.isPlaying;

      tracksWithStatus = session.tracks.map((t, i) => {
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
          duration_ms: t.duration_ms || t.durationMs || 0,
          order: i + 1,
          status
        };
      });
    }

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

export default router;
