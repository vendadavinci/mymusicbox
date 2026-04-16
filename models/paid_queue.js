import mongoose from 'mongoose';

const PaidTrackSchema = new mongoose.Schema({
  uri: { type: String, required: true },
  title: { type: String, required: true },
  artist: { type: String, required: true },
  duration_ms: { type: Number, required: true }, // use consistent snake_case
  albumArt: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
  played: { type: Boolean, default: false },
  orderIndex: { type: Number }
}, { _id: false });

const PaidSessionSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, index: true },
  userId: { type: String },
  checkoutId: { type: String, unique: true, index: true }, // enforce one-to-one
  checkoutRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Checkout' }, // durable link
  packagePrice: { type: Number },
  maxSongs: { type: Number },
  songsAdded: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  tracks: [PaidTrackSchema],
  processedAt: { type: Date }, // marker for idempotency
  playbackStartedAt: { type: Date } // marker for Spotify playback trigger
});

export const PaidSession = mongoose.model('PaidSession', PaidSessionSchema);
