# ShipNovaPortal Architecture

## Core rule
Customer, Driver and Admin clients must use the same versioned backend API.

## API
`/api/v1/...`

## Location
PostgreSQL/PostGIS is the source of truth for persistent driver coordinates.
Redis will be used later for fast availability/matching and transient realtime state.

## Security
- Validate every request at the API boundary.
- Never trust client-supplied role/status.
- Keep secrets in environment variables.
- Verify payment webhooks server-side.
- Add rate limiting before public launch.
- Keep audit records for privileged actions.

## Ride lifecycle (planned)
requested -> searching -> accepted -> driver_arriving -> driver_arrived -> in_progress -> completed

Exceptional states will include cancelled and failed.
