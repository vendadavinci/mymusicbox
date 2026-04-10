// models/checkout.js
import mongoose from 'mongoose';

const CheckoutSchema = new mongoose.Schema({
  checkoutId: { type: String, required: true, unique: true },
  tracks: { type: Array, default: [] },   // store track URIs or objects
  amount: { type: Number, required: true },
  currency: { type: String, default: 'ZAR' },
  description: { type: String, default: 'Musicbox Paid Session' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date }               // optional TTL
});

// Optional: auto‑expire documents after 30 minutes
CheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Checkout = mongoose.model('Checkout', CheckoutSchema);
