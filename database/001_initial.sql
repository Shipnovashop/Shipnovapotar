CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('customer', 'driver', 'admin');
CREATE TYPE account_status AS ENUM ('pending', 'active', 'suspended', 'blocked');
CREATE TYPE driver_status AS ENUM ('offline', 'available', 'busy');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE,
  email VARCHAR(255),
  password_hash TEXT,
  full_name VARCHAR(120),
  status account_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE driver_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status driver_status NOT NULL DEFAULT 'offline',
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  current_location GEOGRAPHY(POINT, 4326),
  last_location_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  vehicle_type VARCHAR(40) NOT NULL,
  registration_number VARCHAR(30) NOT NULL UNIQUE,
  make VARCHAR(80),
  model VARCHAR(80),
  color VARCHAR(40),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX driver_location_gix
  ON driver_profiles USING GIST (current_location);

CREATE UNIQUE INDEX users_email_unique_idx ON users (LOWER(email)) WHERE email IS NOT NULL;
