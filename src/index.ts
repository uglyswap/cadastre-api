import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { testConnection, closePool } from './services/database.js';
import { searchRoutes } from './routes/search.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';

// Créer l'instance Fastify avec timeout étendu pour les recherches géo
const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
  // Timeout de 5 minutes pour les grandes recherches géographiques
  requestTimeout: 300000,
  connectionTimeout: 300000,
  keepAliveTimeout: 300000,
});

// Configuration
async function setupServer() {
  // CORS - permettre toutes les origines pour l'instant
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
  });

  // Rate limiting global (optionnel, peut être désactivé)
  await fastify.register(rateLimit, {
    max: 1000, // Maximum de requêtes par fenêtre
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      success: false,
      error: 'Trop de requêtes',
      code: 'RATE_LIMIT_EXCEEDED',
      details: 'Veuillez réessayer dans quelques instants',
    }),
  });

  // Enregistrer les routes
  await fastify.register(healthRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(adminRoutes);

  // Gestionnaire d'erreur global
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    fastify.log.error(error.message);

    reply.code(error.statusCode || 500).send({
      success: false,
      error: error.message || 'Erreur interne du serveur',
      code: 'INTERNAL_ERROR',
    });
  });

  // Gestionnaire 404
  fastify.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({
      success: false,
      error: 'Route non trouvée',
      code: 'NOT_FOUND',
      details: 'Consultez GET / pour la documentation des endpoints disponibles',
    });
  });
}

// Démarrer le serveur
async function start() {
  try {
    await setupServer();

    // Vérifier la connexion à la base de données (ne pas crasher si échec)
    const dbConnected = await testConnection();
    if (!dbConnected) {
      fastify.log.warn('ATTENTION: Impossible de se connecter à la base de données - les recherches ne fonctionneront pas');
    } else {
      fastify.log.info('Connexion à la base de données établie');
    }

    // Démarrer le serveur
    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    fastify.log.info(`Serveur démarré sur http://${config.host}:${config.port}`);
    fastify.log.info('Timeout configuré: 5 minutes pour les recherches géographiques');
    fastify.log.info('Endpoints admin BAN: GET /admin/ban/status, POST /admin/ban/setup, POST /admin/ban/import');
  } catch (err) {
    fastify.log.error(err instanceof Error ? err.message : 'Erreur inconnue');
    process.exit(1);
  }
}

// Gestion propre de l'arrêt
async function shutdown() {
  fastify.log.info('Arrêt du serveur...');

  try {
    await fastify.close();
    await closePool();
    fastify.log.info('Serveur arrêté proprement');
    process.exit(0);
  } catch (err) {
    fastify.log.error(err instanceof Error ? err.message : 'Erreur lors de l\'arrêt');
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Lancer le serveur
start();
