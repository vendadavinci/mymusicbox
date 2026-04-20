import mongoose from 'mongoose';
import { Checkout } from '../models/checkout.js';
import { PaidSession } from '../models/paid_queue.js';

const PaidTrackSchema = new mongoose.Schema({
  uri: { type: String, required: true },
  title: { type: String, required: true },
  artist: { type: String, required: true },
  durationMs: { type: Number, alias: 'duration_ms', required: true },
  albumArt: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
  played: { type: Boolean, default: false },
  orderIndex: { type: Number },
  status: { 
    type: String, 
    enum: ['Added', 'Playing', 'Played', 'Paused'], 
    default: 'Added' 
  }
}, { _id: false });

const CheckoutSchema = new mongoose.Schema({
  checkoutId: { type: String, unique: true, index: true },
  userId: { type: String, index: true },   // ✅ scoping per user
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  description: { type: String },
  successUrl: { type: String },
  cancelUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }, // expiry marker for TTL
  tracks: [PaidTrackSchema],
  sessionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PaidSession' },
  processedAt: { type: Date },
  playbackStartedAt: { type: Date }
});

// TTL index: automatically remove expired checkouts
CheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ✅ Named export
export const Checkout = mongoose.model('Checkout', CheckoutSchema);
