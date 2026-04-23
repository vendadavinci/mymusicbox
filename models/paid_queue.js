// models/paid_queue.js
import mongoose from 'mongoose';

const PaidTrackSchema = new mongoose.Schema({
  uri: { type: String, required: true },
  title: { type: String, required: true },
  artist: { type: String, required: true },
  durationMs: { type: Number, alias: 'duration_ms', required: true },
  albumArt: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
  played: { type: Boolean, default: false },
  orderIndex: { type: Number },
  // ✅ Explicit status field
  status: { 
    type: String, 
    enum: ['Added', 'Playing', 'Played', 'Paused'], 
    default: 'Added' 
  }
}, { _id: false });

const PaidSessionSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, index: true },
  userId: { type: String },
  checkoutId: { type: String, unique: true, index: true }, 
  checkoutRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' },
  packagePrice: { type: Number },
  maxSongs: { type: Number },
  songsAdded: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },   // ✅ used for TTL cleanup
  tracks: [PaidTrackSchema],
  processedAt: { type: Date }, 
  playbackStartedAt: { type: Date }, 
  currentUri: { type: String },
  // ✅ Persist playback state at session level
  isPlaying: { type: Boolean, default: false }
});

// ✅ TTL index: auto-delete sessions once endedAt is set
PaidSessionSchema.index({ endedAt: 1 }, { expireAfterSeconds: 0 });

export const PaidSession = mongoose.model('PaidSession', PaidSessionSchema);
