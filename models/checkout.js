// models/checkout.js
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

const CheckoutSchema = new mongoose.Schema({
  checkoutId: { type: String, unique: true, index: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  description: { type: String },
  successUrl: { type: String },
  cancelUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }, // expiry marker for TTL
  tracks: [PaidTrackSchema],

  // Durable link back to the session
  sessionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PaidSession' },

  // Markers for idempotency and playback
  processedAt: { type: Date },          // when this checkout was consumed into a session
  playbackStartedAt: { type: Date }     // when playback was triggered for this checkout
});

// TTL index: automatically remove expired checkouts
CheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Checkout = mongoose.model('Checkout', CheckoutSchema);
