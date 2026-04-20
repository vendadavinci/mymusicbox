// models/paid_queue.js
import mongoose from 'mongoose';

const PaidTrackSchema = new mongoose.Schema({
  uri: { type: String, required: true }, // always store normalized spotify:track:... URIs
  title: { type: String, required: true },
  artist: { type: String, required: true },
  duration_ms: { type: Number, required: true }, // unified field name
  albumArt: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
  played: { type: Boolean, default: false },
  orderIndex: { type: Number }
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
  endedAt: { type: Date },
  tracks: [PaidTrackSchema],
  processedAt: { type: Date }, 
  playbackStartedAt: { type: Date }, 
  currentUri: { type: String }, // normalized
  isPlaying: { type: Boolean, default: false } // persisted playback state
});

export const PaidSession = mongoose.model('PaidSession', PaidSessionSchema);
