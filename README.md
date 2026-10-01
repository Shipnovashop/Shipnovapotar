
# ShipNovaPortal v16

Production integration foundation with:
- PostgreSQL/PostGIS
- Redis
- JWT auth
- Customer/driver/admin flows
- Bookings and driver assignment
- Delivery tracking and OTP
- Notifications API + database migration
- Razorpay payment verification/webhook
- Idempotent migration runner
- Docker Compose local integration environment

## Local integration
1. Copy environment values from `backend/.env.example` and use a strong JWT secret.
2. Run `docker compose up --build`.
3. API health: `http://localhost:4000/health`.
4. Migrations run automatically before the API starts in Compose.

For production, set secrets through the hosting provider rather than committing `.env` files.
