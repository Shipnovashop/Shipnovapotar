-- ShipNovaPortal Live Delivery / OTP / Tracking
CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES driver_profiles(id) ON DELETE SET NULL,
  tracking_code VARCHAR(32) NOT NULL UNIQUE,
  otp_hash TEXT,
  otp_expires_at TIMESTAMPTZ,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  otp_verified_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id BIGSERIAL PRIMARY KEY,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES driver_profiles(id) ON DELETE SET NULL,
  event_type VARCHAR(40) NOT NULL,
  note VARCHAR(500),
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deliveries_booking_idx ON deliveries(booking_id);
CREATE INDEX IF NOT EXISTS delivery_events_booking_idx ON delivery_events(booking_id, created_at DESC);
