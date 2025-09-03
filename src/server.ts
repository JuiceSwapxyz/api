import 'dotenv/config';
import express from 'express';
import { lambdaToExpress } from './adapters/lambdaToHttp';

// Import existing handlers WITHOUT changing them
const { quoteHandler } = require('../lib/handlers');

async function bootstrap() {
  const app = express();

  // Minimal middleware for MVP
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // Route mapping - handlers remain completely unchanged
  app.get('/quote', lambdaToExpress(quoteHandler));

  // Health endpoints
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));
  app.get('/readyz', (_req, res) => res.status(200).send('ready'));

  const port = Number(process.env.PORT ?? 8080);
  const server = app.listen(port, () => {
    console.log(`routing-api listening on :${port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

bootstrap();