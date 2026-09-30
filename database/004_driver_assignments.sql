-- ShipNovaPortal Driver Assignment System
DO $$ BEGIN
  CREATE TYPE assignment_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS booking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE RESTRICT,
  status assignment_status NOT NULL DEFAULT 'pending',
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  distance_km NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS booking_assignments_booking_idx ON booking_assignments(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS booking_assignments_driver_idx ON booking_assignments(driver_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS booking_assignments_active_booking_idx
  ON booking_assignments(booking_id)
  WHERE status IN ('pending', 'accepted');
