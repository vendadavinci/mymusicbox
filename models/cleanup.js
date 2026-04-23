// models/cleanup.js

import cron from 'node-cron';
import mongoose from 'mongoose';
import { PaidSession } from './models/paid_queue.js';

// Run every minute
cron.schedule('* * * * *', async () => {
  try {
    console.log('[CLEANUP] Checking for finished sessions...');

    // ✅ Look at all sessions, not just active ones
    const sessions = await PaidSession.find({});

    for (const session of sessions) {
      const allPlayed = session.tracks.length > 0 &&
        session.tracks.every(t => t.status === 'Played');

      // ✅ Delete if all tracks are played and playback has stopped
if (allPlayed && !session.isPlaying) {
  console.log(`[CLEANUP] Deleting session: ${session._id}`);
  await PaidSession.deleteOne({ _id: session._id });  // <-- delete by _id
}


      // ✅ Optional safeguard: delete sessions older than 2 hours
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      if (session.startedAt < twoHoursAgo) {
        console.log(`[CLEANUP] Expired session removed: ${session.checkoutId} (${session.sessionId})`);
        await PaidSession.deleteOne({ _id: session._id });
      }
    }
  } catch (err) {
    console.error('[CLEANUP] Error during cleanup:', err);
  }
});

