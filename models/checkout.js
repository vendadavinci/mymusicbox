// models/checkout.js
import mongoose from 'mongoose';

const PaidTrackSchema = new mongoose.Schema({
  uri: { type: String, required: true },
  title: { type: String, required: true },
  artist: { type: String, required: true },
  durationMs: { type: Number, alias: 'duration_ms', required: true },
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
  tracks: [PaidTrackSchema],
  sessionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PaidSession' } // durable link back
});

export const Checkout = mongoose.model('Checkout', CheckoutSchema);
