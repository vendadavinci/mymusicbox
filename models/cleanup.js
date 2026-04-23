import cron from 'node-cron';
import mongoose from 'mongoose';
import { PaidSession } from './models/paid_queue.js';

// Run every minute
cron.schedule('* * * * *', async () => {
  try {
    console.log('[CLEANUP] Checking for finished sessions...');

    // Find sessions that are still marked active
    const sessions = await PaidSession.find({ active: true });

    for (const session of sessions) {
      const allPlayed = session.tracks.length > 0 &&
        session.tracks.every(t => t.status === 'Played');

      if (allPlayed && !session.isPlaying) {
        console.log(`[CLEANUP] Deleting session: ${session.checkoutId} (${session.sessionId})`);
        await PaidSession.deleteOne({ _id: session._id });
      }
    }
  } catch (err) {
    console.error('[CLEANUP] Error during cleanup:', err);
  }
});
