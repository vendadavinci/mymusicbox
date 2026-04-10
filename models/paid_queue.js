// models/paid_queue.js
import mongoose from 'mongoose';

const PaidTrackSchema = new mongoose.Schema({
  uri: String,
  title: String,
  artist: String,
  durationMs: Number,
  albumArt: String,
  addedAt: { type: Date, default: Date.now },
  played: { type: Boolean, default: false },
  orderIndex: Number
});

const PaidSessionSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true },
  userId: String,
  checkoutId: String,
  packagePrice: Number,
  maxSongs: Number,
  songsAdded: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: Date,
  tracks: [PaidTrackSchema]
});

export const PaidSession = mongoose.model('PaidSession', PaidSessionSchema);
