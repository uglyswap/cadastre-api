import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchByAddress, searchBySiren, searchByDenomination } from '../services/search.js';
import { authHook } from '../middleware/auth.js';

// Types pour les requêtes
interface SearchByAddressQuery {
  adresse: string;
  departement?: string;
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

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // Route: Recherche par adresse
  fastify.get<{ Querystring: SearchByAddressQuery }>(
    '/search/address',
    { ...authHook },
    async (request: FastifyRequest<{ Querystring: SearchByAddressQuery }>, reply: FastifyReply) => {
      const { adresse, departement, limit } = request.query;

      if (!adresse || adresse.trim().length < 3) {
        return reply.code(400).send({
          success: false,
          error: 'Paramètre adresse requis',
          code: 'MISSING_ADDRESS',
          details: 'Le paramètre "adresse" doit contenir au moins 3 caractères',
        });
      }

      try {
        const { proprietaires, total } = await searchByAddress(adresse, departement, limit);

        // Convertir la Map en tableau pour la réponse JSON
        const resultats = Array.from(proprietaires.values()).map(entry => ({
          proprietaire: entry.proprietaire,
          entreprise: entry.entreprise,
          proprietes: entry.proprietes,
          nombre_proprietes: entry.proprietes.length,
        }));

        return reply.send({
          success: true,
          query: {
            adresse,
            departement: departement || null,
          },
          resultats,
          total_proprietes: total,
          total_proprietaires: resultats.length,
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
          total_proprietes: result.proprietes.length,
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
        const { resultats, total } = await searchByDenomination(denomination, departement, limit);

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
            nombre_proprietes: r.proprietes.length,
            departements_concernes: r.departements_concernes,
          })),
          total_proprietes: total,
          total_proprietaires: resultats.length,
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
}
