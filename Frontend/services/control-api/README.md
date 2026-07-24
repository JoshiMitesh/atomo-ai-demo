## ATOMO Control API (NestJS)

This is the **cloud/master control plane** API for the distributed master/slave edge platform.

### Dev (local)

1. Start dependencies:

```bash
docker compose -f docker-compose.atomo.yml up -d
```

2. Configure environment:

- Create `services/control-api/.env` with:

```bash
DATABASE_URL="postgresql://atomo:atomo@localhost:5432/atomo_control?schema=public"
REDIS_URL="redis://localhost:6379"
MQTT_URL="mqtt://localhost:1883"
JWT_SECRET="dev-secret-change-me"
```

3. Install + run:

```bash
npm install
npm run dev --workspace @atomo/control-api
```

