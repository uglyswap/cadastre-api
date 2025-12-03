import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchByAddress, searchBySiren, searchByDenomination } from '../services/search.js';
import { searchByPolygon, getBanStats } from '../services/geo-search.js';
import { authHook } from '../middleware/auth.js';

// Types pour les requêtes
interface SearchByAddressQuery {
  adresse: string;
  departement?: string;
  code_postal?: string;
  limit?: number;
}

interface SearchBySirenQuery {
  siren: string;
  departement?: string;
}

interface SearchByDenominationQuery {
  denomination: string;
  departement?: string;
  limit?: number;
}

interface SearchByPolygonBody {
  polygon: number[][];
  limit?: number;
}

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // Route: Recherche par adresse
  fastify.get<{ Querystring: SearchByAddressQuery }>(
    '/search/address',
    { ...authHook },
    async (request: FastifyRequest<{ Querystring: SearchByAddressQuery }>, reply: FastifyReply) => {
      const { adresse, departement, code_postal, limit } = request.query;

      if (!adresse || adresse.trim().length < 3) {
        return reply.code(400).send({
          success: false,
          error: 'Paramètre adresse requis',
          code: 'MISSING_ADDRESS',
          details: 'Le paramètre "adresse" doit contenir au moins 3 caractères',
        });
      }

      try {
        const { resultats, total_proprietaires, total_lots } = await searchByAddress(adresse, departement, limit, code_postal);

        return reply.send({
          success: true,
          query: {
            adresse,
            departement: departement || null,
            code_postal: code_postal || null,
          },
          resultats: resultats.map(r => ({
            proprietaire: r.proprietaire,
            entreprise: r.entreprise,
            proprietes: r.proprietes,
            nombre_adresses: r.nombre_adresses,
            nombre_lots: r.nombre_lots,
          })),
          total_proprietaires,
          total_lots,
        });
      } catch (error) {
        console.error('Erreur recherche par adresse:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur interne du serveur',
          code: 'INTERNAL_ERROR',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Route: Recherche par SIREN
  fastify.get<{ Querystring: SearchBySirenQuery }>(
    '/search/siren',
    { ...authHook },
    async (request: FastifyRequest<{ Querystring: SearchBySirenQuery }>, reply: FastifyReply) => {
      const { siren, departement } = request.query;

      if (!siren || siren.length !== 9) {
        return reply.code(400).send({
          success: false,
          error: 'SIREN invalide',
          code: 'INVALID_SIREN',
          details: 'Le SIREN doit contenir exactement 9 chiffres',
        });
      }

      try {
        const result = await searchBySiren(siren, departement);

        return reply.send({
          success: true,
          query: {
            siren,
            departement: departement || null,
          },
          proprietaire: result.proprietaire,
          entreprise: result.entreprise,
          proprietes: result.proprietes,
          nombre_adresses: result.nombre_adresses,
          nombre_lots: result.nombre_lots,
          departements_concernes: result.departements_concernes,
        });
      } catch (error) {
        console.error('Erreur recherche par SIREN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur interne du serveur',
          code: 'INTERNAL_ERROR',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Route: Recherche par dénomination (nom du propriétaire)
  fastify.get<{ Querystring: SearchByDenominationQuery }>(
    '/search/owner',
    { ...authHook },
    async (request: FastifyRequest<{ Querystring: SearchByDenominationQuery }>, reply: FastifyReply) => {
      const { denomination, departement, limit } = request.query;

      if (!denomination || denomination.trim().length < 2) {
        return reply.code(400).send({
          success: false,
          error: 'Paramètre denomination requis',
          code: 'MISSING_DENOMINATION',
          details: 'Le paramètre "denomination" doit contenir au moins 2 caractères',
        });
      }

      try {
        const { resultats, total_proprietaires, total_lots } = await searchByDenomination(denomination, departement, limit);

        return reply.send({
          success: true,
          query: {
            denomination,
            departement: departement || null,
          },
          resultats: resultats.map(r => ({
            proprietaire: r.proprietaire,
            entreprise: r.entreprise,
            proprietes: r.proprietes,
            nombre_adresses: r.nombre_adresses,
            nombre_lots: r.nombre_lots,
            departements_concernes: r.departements_concernes,
          })),
          total_proprietaires,
          total_lots,
        });
      } catch (error) {
        console.error('Erreur recherche par dénomination:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur interne du serveur',
          code: 'INTERNAL_ERROR',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Route: Recherche par zone géographique (polygone)
  fastify.post<{ Body: SearchByPolygonBody }>(
    '/search/geo',
    { ...authHook },
    async (request: FastifyRequest<{ Body: SearchByPolygonBody }>, reply: FastifyReply) => {
      const { polygon, limit } = request.body;

      // Validation du polygone
      if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
        return reply.code(400).send({
          success: false,
          error: 'Polygone invalide',
          code: 'INVALID_POLYGON',
          details: 'Le polygone doit contenir au moins 3 points [[lng, lat], ...]',
        });
      }

      // Vérifier que chaque point a 2 coordonnées
      for (const point of polygon) {
        if (!Array.isArray(point) || point.length !== 2 ||
            typeof point[0] !== 'number' || typeof point[1] !== 'number') {
          return reply.code(400).send({
            success: false,
            error: 'Format de coordonnées invalide',
            code: 'INVALID_COORDINATES',
            details: 'Chaque point doit être au format [longitude, latitude] (nombres)',
          });
        }
      }

      // Limiter la taille du polygone
      if (polygon.length > 100) {
        return reply.code(400).send({
          success: false,
          error: 'Polygone trop complexe',
          code: 'POLYGON_TOO_COMPLEX',
          details: 'Le polygone ne doit pas dépasser 100 points',
        });
      }

      try {
        const result = await searchByPolygon(polygon, limit || 100);

        return reply.send({
          success: true,
          query: {
            polygon_points: polygon.length,
            limit: limit || 100,
          },
          resultats: result.resultats,
          total_proprietaires: result.total_proprietaires,
          total_lots: result.total_lots,
          stats: {
            adresses_ban_trouvees: result.adresses_ban_trouvees,
            adresses_matchees: result.adresses_matchees,
          },
        });
      } catch (error) {
        console.error('Erreur recherche géographique:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur interne du serveur',
          code: 'INTERNAL_ERROR',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Route: Statistiques BAN (pour vérifier l'état de l'import)
  fastify.get(
    '/admin/ban/stats',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await getBanStats();

        return reply.send({
          success: true,
          ban: stats,
          message: stats.postgis_installed
            ? stats.total_adresses > 0
              ? 'BAN importée et prête'
              : 'PostGIS installé, BAN non importée. Exécutez scripts/import-ban.ts'
            : 'PostGIS non installé. Exécutez scripts/setup-ban.sql',
        });
      } catch (error) {
        console.error('Erreur stats BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors de la récupération des stats',
          code: 'INTERNAL_ERROR',
        });
      }
    }
  );
}
