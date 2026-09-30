-- ShipNovaPortal Booking System
DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM (
    'requested', 'searching_driver', 'driver_assigned', 'driver_accepted',
    'picked_up', 'out_for_delivery', 'delivered', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_number VARCHAR(32) NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  pickup_address TEXT NOT NULL,
  pickup_location GEOGRAPHY(POINT, 4326) NOT NULL,
  drop_address TEXT NOT NULL,
  drop_location GEOGRAPHY(POINT, 4326) NOT NULL,
  package_description VARCHAR(500) NOT NULL,
  weight_kg NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
  vehicle_type VARCHAR(40) NOT NULL DEFAULT 'bike',
  distance_km NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
  base_fare NUMERIC(10,2) NOT NULL DEFAULT 50,
  per_km_rate NUMERIC(10,2) NOT NULL DEFAULT 12,
  weight_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_fare NUMERIC(10,2) NOT NULL DEFAULT 50,
  status booking_status NOT NULL DEFAULT 'requested',
  customer_note VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_pickup_gix ON bookings USING GIST(pickup_location);
CREATE INDEX IF NOT EXISTS bookings_drop_gix ON bookings USING GIST(drop_location);
