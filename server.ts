import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { initDatabasePlatform } from './src/server/database/databaseManager.ts';
import { createApiRouter } from './src/server/routes.ts';

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  initDatabasePlatform();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  app.use(createApiRouter());

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MANDATO servidor ativo em http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Erro fatal ao iniciar servidor MANDATO:', err);
  process.exit(1);
});
