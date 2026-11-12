# Exchange

Mobile-first USD/USDT to Birr exchange application.

## Local development

Run the backend and frontend in separate terminals:

```powershell
cd backend
npm install
npm run dev
```

```powershell
cd frontend
npm run dev
```

The backend reads `DATABASE_URL`, `P2P_ARMY_API_KEY`, and `FRONTEND_ORIGIN` from its environment. Never commit `backend/.env`.

## Render and Neon

`render.yaml` deploys only the Express backend. In Render, set `DATABASE_URL` to the Neon connection string with `sslmode=require`, set `P2P_ARMY_API_KEY`, and set `FRONTEND_ORIGIN` to the deployed frontend origin. The backend listens on Render's `PORT` and `0.0.0.0`.
