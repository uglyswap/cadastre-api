import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { testConnection } from '../services/database.js';
import { listAvailableDepartments } from '../utils/table-resolver.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  // Route: Health check (pas d'authentification requise)
  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const dbConnected = await testConnection();

    if (!dbConnected) {
      return reply.code(503).send({
        success: false,
        status: 'unhealthy',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }

    return reply.send({
      success: true,
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  });

  // Route: Liste des départements disponibles
  fastify.get('/departments', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const departments = await listAvailableDepartments();

      return reply.send({
        success: true,
        departements: departments,
        total: departments.length,
      });
    } catch (error) {
      console.error('Erreur récupération départements:', error);
      return reply.code(500).send({
        success: false,
        error: 'Erreur interne du serveur',
        code: 'INTERNAL_ERROR',
      });
    }
  });

  // Route: Documentation de l'API
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      name: 'Cadastre API',
      version: '1.0.0',
      description: 'API de recherche cadastrale avec enrichissement entreprises',
      endpoints: {
        'GET /health': 'Vérification de l\'état de l\'API',
        'GET /departments': 'Liste des départements disponibles',
        'GET /search/address': {
          description: 'Recherche de propriétaires par adresse',
          params: {
            adresse: 'Texte de recherche (requis, min 3 caractères)',
            departement: 'Code département pour filtrer (optionnel)',
            limit: 'Nombre max de résultats (optionnel)',
          },
          auth: 'X-API-Key header requis',
        },
        'GET /search/siren': {
          description: 'Recherche des propriétés d\'un propriétaire par SIREN',
          params: {
            siren: 'Numéro SIREN à 9 chiffres (requis)',
            departement: 'Code département pour filtrer (optionnel)',
          },
          auth: 'X-API-Key header requis',
        },
        'GET /search/owner': {
          description: 'Recherche de propriétaires par nom/dénomination',
          params: {
            denomination: 'Nom ou raison sociale à rechercher (requis, min 2 caractères)',
            departement: 'Code département pour filtrer (optionnel)',
            limit: 'Nombre max de résultats (optionnel)',
          },
          auth: 'X-API-Key header requis',
        },
      },
      authentication: {
        method: 'API Key',
        header: 'X-API-Key',
        description: 'Incluez votre clé API dans le header X-API-Key pour les routes protégées',
      },
    });
  });
}
