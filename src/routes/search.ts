import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchByAddress, searchBySiren, searchByDenomination } from '../services/search.js';
import { searchByPolygon } from '../services/geo-search.js';
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
  stream?: boolean;
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
  // Utilise NDJSON streaming pour éviter les timeouts sur les grandes zones
  fastify.post<{ Body: SearchByPolygonBody }>(
    '/search/geo',
    { ...authHook },
    async (request: FastifyRequest<{ Body: SearchByPolygonBody }>, reply: FastifyReply) => {
      // Set timeout on raw socket for long-running requests
      request.raw.setTimeout(300000);
      
      const { polygon, limit, stream } = request.body;

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

      const effectiveLimit = limit || 10000;

      // Mode streaming NDJSON pour les grandes requêtes
      if (stream) {
        // Hijack the reply to get full control over the response
        reply.hijack();
        
        const res = reply.raw;
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        // Helper function to write and flush
        const writeAndFlush = (data: string) => {
          res.write(data);
          // Force flush if available
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        };

        // Envoyer un heartbeat initial immédiatement
        writeAndFlush(JSON.stringify({ type: 'start', message: 'Recherche géographique démarrée', timestamp: new Date().toISOString() }) + '\n');

        // Setup heartbeat interval to keep connection alive
        let heartbeatCount = 0;
        const heartbeatInterval = setInterval(() => {
          heartbeatCount++;
          writeAndFlush(JSON.stringify({ type: 'heartbeat', count: heartbeatCount, message: 'Traitement en cours...', timestamp: new Date().toISOString() }) + '\n');
        }, 5000); // Every 5 seconds

        try {
          const result = await searchByPolygon(polygon, effectiveLimit);

          // Clear heartbeat
          clearInterval(heartbeatInterval);

          // Envoyer le résultat final
          writeAndFlush(JSON.stringify({
            type: 'result',
            success: true,
            query: {
              polygon_points: polygon.length,
              limit: limit || 'illimité',
            },
            resultats: result.resultats,
            total_proprietaires: result.total_proprietaires,
            total_lots: result.total_lots,
            stats: {
              adresses_ban_trouvees: result.adresses_ban_trouvees,
              adresses_matchees: result.adresses_matchees,
            },
            limites_appliquees: result.limites_appliquees,
            timestamp: new Date().toISOString(),
          }) + '\n');

          // Send completion message
          writeAndFlush(JSON.stringify({ type: 'complete', message: 'Recherche terminée', timestamp: new Date().toISOString() }) + '\n');

          res.end();
        } catch (error) {
          clearInterval(heartbeatInterval);
          console.error('Erreur recherche géographique (stream):', error);
          writeAndFlush(JSON.stringify({
            type: 'error',
            success: false,
            error: 'Erreur interne du serveur',
            code: 'INTERNAL_ERROR',
            details: error instanceof Error ? error.message : 'Erreur inconnue',
            timestamp: new Date().toISOString(),
          }) + '\n');
          res.end();
        }
        return;
      }

      // Mode standard (non-streaming)
      try {
        const result = await searchByPolygon(polygon, effectiveLimit);

        return reply.send({
          success: true,
          query: {
            polygon_points: polygon.length,
            limit: limit || 'illimité',
          },
          count: result.total_proprietaires,
          proprietaires: result.resultats,
          total_proprietaires: result.total_proprietaires,
          total_lots: result.total_lots,
          stats: {
            adresses_ban_trouvees: result.adresses_ban_trouvees,
            adresses_matchees: result.adresses_matchees,
          },
          limites_appliquees: result.limites_appliquees,
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
}
