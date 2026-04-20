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

    // Scope checkout by both checkoutId and userId
    const entry = await Checkout.findOne({ checkoutId, userId });
    if (!entry) {
      return res.status(404).json({ error: 'checkout not found or expired for this user' });
    }

    const normalizedTracks = (entry.tracks || []).map((track, i) => ({
      uri: track.uri,
      title: track.title,
      artist: track.artist,
      albumArt: track.albumArt,
      duration_ms: track.duration_ms || 0,
      order: i + 1
    }));

    // Scope PaidSession by both checkoutId and userId
    const session = await PaidSession.findOne({ checkoutId, userId });
    let tracksWithStatus = normalizedTracks;

    if (session) {
      const current = session.tracks.find(t => !t.played);
      tracksWithStatus = session.tracks.map(t => {
        let status = 'Added';
        if (t.played) status = 'Played';
        else if (current && t.uri === current.uri) status = 'Playing';
        return { ...t.toObject?.() || t, status };
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
