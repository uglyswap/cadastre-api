import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchBySiren, searchByDenomination } from '../services/search.js';
import { searchByPolygon, searchByPolygonStreaming, getGeoStats, searchByRadius, searchByAddressPostgis, ProprietaireResult } from '../services/geo-search-postgis.js';
import { authHook } from '../middleware/auth.js';
import { config } from '../config/index.js';
import {
  enrichParcelles,
  enrichParcellesDetailed,
  ParcelleEnrichment,
  MAX_PARCELLES_PAR_APPEL,
} from '../services/enrichment.js';
import { ProprieteGroupee } from '../types/index.js';
import { sendServerError } from '../utils/api-error.js';
import { randomUUID } from 'node:crypto';

/**
 * Attache les donnees de parcelle et l'historique des ventes aux resultats
 * d'une recherche.
 *
 * Jusqu'ici les resultats de recherche ne portaient AUCUNE donnee de parcelle :
 * l'enrichissement n'existait que sur une route separee que l'appelant devait
 * penser a interroger dans un second temps, avec une cle qu'il devait
 * reconstruire lui-meme. Le prix de la derniere vente etait de surcroit calcule
 * puis jete avant d'etre renvoye.
 *
 * L'enrichissement est attache a DEUX niveaux :
 *   - sur chaque reference cadastrale, la donnee de SA parcelle ;
 *   - au niveau du resultat, un resume portant sur la parcelle la plus
 *     significative, pour l'affichage en liste.
 */
/**
 * Choisit la parcelle representative d'un proprietaire : celle dont la vente
 * est la plus recente, a defaut la plus grande. Prendre la premiere du tableau,
 * comme le faisait l'appelant precedent, retenait une parcelle arbitraire.
 */
function choisirParcellePrincipale(
  candidates: ParcelleEnrichment[]
): ParcelleEnrichment | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestDate = best.derniere_vente?.date_mutation || '';
    const currentDate = current.derniere_vente?.date_mutation || '';
    if (currentDate !== bestDate) return currentDate > bestDate ? current : best;
    const bestSurface = best.surface_parcelle_m2 || 0;
    const currentSurface = current.surface_parcelle_m2 || 0;
    return currentSurface > bestSurface ? current : best;
  });
}

async function attachEnrichment(
  resultats: Array<{ proprietes?: ProprieteGroupee[]; enrichissement?: ParcelleEnrichment | null }>
): Promise<{ parcelles_enrichies: number; sources_en_echec: string[] }> {
  const idus: string[] = [];
  for (const resultat of resultats) {
    for (const propriete of resultat.proprietes || []) {
      for (const reference of propriete.references_cadastrales || []) {
        if (reference.idu) idus.push(reference.idu);
      }
    }
  }

  const uniques = [...new Set(idus)];
  if (uniques.length === 0) {
    return { parcelles_enrichies: 0, sources_en_echec: [] };
  }

  // Plafond de securite : au-dela, on enrichit les premieres parcelles plutot
  // que de faire tomber la recherche entiere. Le plafond est signale a
  // l'appelant par `parcelles_enrichies` inferieur au nombre de references.
  const lot = uniques.slice(0, MAX_PARCELLES_PAR_APPEL);
  const { results, failures } = await enrichParcellesDetailed(lot);

  for (const resultat of resultats) {
    const candidates: ParcelleEnrichment[] = [];
    for (const propriete of resultat.proprietes || []) {
      for (const reference of propriete.references_cadastrales || []) {
        const data = reference.idu ? results.get(reference.idu) : undefined;
        reference.enrichissement = data || null;
        if (data) candidates.push(data);
      }
    }
    resultat.enrichissement = choisirParcellePrincipale(candidates);
  }

  return { parcelles_enrichies: results.size, sources_en_echec: failures };
}

/** L'enrichissement est actif par defaut et desactivable par `enrich=false`. */
function wantsEnrichment(value: unknown): boolean {
  return !(value === false || value === 'false' || value === '0');
}

// Borne un limit utilisateur entre 1 et config.search.maxLimit (anti-DoS memoire),
// y compris en mode streaming ou un limit absent retombe sur defaultLimit.
function clampLimit(limit?: number): number {
  const requested = typeof limit === 'number' && limit > 0 ? limit : config.search.defaultLimit;
  return Math.min(requested, config.search.maxLimit);
}

// BUILD v2.4.0 - 2025-12-05 - Unlimited enrichment for streaming mode

// Types pour les requêtes
interface SearchByAddressQuery {
  adresse: string;
  departement?: string;
  code_postal?: string;
  limit?: number;
  /** Enrichissement parcelle + ventes DVF. Actif par defaut. */
  enrich?: string | boolean;
}

interface SearchBySirenQuery {
  siren: string;
  departement?: string;
  enrich?: string | boolean;
}

interface SearchByDenominationQuery {
  denomination: string;
  departement?: string;
  limit?: number;
  enrich?: string | boolean;
}

interface SearchByPolygonBody {
  polygon: number[][];
  limit?: number;
  stream?: boolean;
  /**
   * Enrichissement parcelle + ventes. Actif par defaut en mode batch.
   * Ignore en mode streaming : il faudrait une requete par proprietaire, ce qui
   * serialiserait des centaines d'allers-retours base pendant le flux.
   */
  enrich?: string | boolean;
}

interface SearchByRadiusBody {
  longitude: number;
  latitude: number;
  radius_meters: number;
  limit?: number;
  enrich?: string | boolean;
}

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // Route: Recherche par adresse - UTILISE MAINTENANT proprietaires_geo via searchByAddressPostgis
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
        // FIX: Utilise searchByAddressPostgis qui cherche dans proprietaires_geo (22M+ géocodés)
        const { resultats, total_proprietaires, total_lots, debug } = await searchByAddressPostgis(adresse, departement, clampLimit(limit), code_postal);

        const payload = resultats.map(r => ({
          proprietaire: r.proprietaire,
          entreprise: r.entreprise,
          proprietes: r.proprietes,
          nombre_adresses: r.nombre_adresses,
          nombre_lots: r.nombre_lots,
        }));

        const enrichissement = wantsEnrichment(request.query.enrich)
          ? await attachEnrichment(payload)
          : null;

        return reply.send({
          success: true,
          query: {
            adresse,
            departement: departement || null,
            code_postal: code_postal || null,
          },
          resultats: payload,
          total_proprietaires,
          total_lots,
          enrichissement,
          debug,
        });
      } catch (error) {
        return sendServerError(reply, 'recherche par adresse', error);
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

        const enveloppe = [{ proprietes: result.proprietes }];
        const enrichissement = wantsEnrichment(request.query.enrich)
          ? await attachEnrichment(enveloppe as any)
          : null;

        return reply.send({
          success: true,
          query: {
            siren,
            departement: departement || null,
          },
          enrichissement,
          proprietaire: result.proprietaire,
          entreprise: result.entreprise,
          proprietes: result.proprietes,
          nombre_adresses: result.nombre_adresses,
          nombre_lots: result.nombre_lots,
          departements_concernes: result.departements_concernes,
        });
      } catch (error) {
        return sendServerError(reply, 'recherche par SIREN', error);
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
        const { resultats, total_proprietaires, total_lots } = await searchByDenomination(denomination, departement, clampLimit(limit));

        const payload = resultats.map(r => ({
          proprietaire: r.proprietaire,
          entreprise: r.entreprise,
          proprietes: r.proprietes,
          nombre_adresses: r.nombre_adresses,
          nombre_lots: r.nombre_lots,
          departements_concernes: r.departements_concernes,
        }));

        const enrichissement = wantsEnrichment(request.query.enrich)
          ? await attachEnrichment(payload)
          : null;

        return reply.send({
          success: true,
          query: {
            denomination,
            departement: departement || null,
          },
          resultats: payload,
          total_proprietaires,
          total_lots,
          enrichissement,
        });
      } catch (error) {
        return sendServerError(reply, 'recherche par dénomination', error);
      }
    }
  );

  // Route: Recherche par zone géographique (polygone) - PostGIS native
  // Utilise NDJSON streaming PROGRESSIF pour éviter les timeouts sur les grandes zones
  fastify.post<{ Body: SearchByPolygonBody }>(
    '/search/geo',
    { ...authHook },
    async (request: FastifyRequest<{ Body: SearchByPolygonBody }>, reply: FastifyReply) => {
      // Set timeout on raw socket for long-running requests
      request.raw.setTimeout(600000); // 10 minutes max
      
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

      const effectiveLimit = clampLimit(limit);

      // Mode streaming PROGRESSIF NDJSON - envoie chaque résultat dès qu'il est enrichi
      if (stream) {
        // Hijack the reply to get full control over the response
        reply.hijack();
        
        const res = reply.raw;
        
        // Track if client has closed connection
        let clientClosed = false;
        let streamEnded = false;
        
        // Listen for client disconnect
        res.on('close', () => {
          if (!streamEnded) {
            clientClosed = true;
            console.log('[stream] Client closed connection');
          }
        });
        
        res.on('error', (err) => {
          clientClosed = true;
          console.error('[stream] Response error:', err.message);
        });
        
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // Disable nginx buffering
        });

        // Helper function to write and flush safely
        const writeAndFlush = (data: string): boolean => {
          if (clientClosed || streamEnded) {
            return false;
          }
          try {
            const canContinue = res.write(data);
            // Force flush if available
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
            return canContinue !== false;
          } catch (err) {
            console.error('[stream] Write error:', err);
            clientClosed = true;
            return false;
          }
        };

        // Safe end function
        const safeEnd = () => {
          if (!streamEnded) {
            streamEnded = true;
            try {
              res.end();
            } catch (err) {
              console.error('[stream] Error ending response:', err);
            }
          }
        };

        // Envoyer un message de démarrage
        writeAndFlush(JSON.stringify({ 
          type: 'start', 
          message: 'Recherche géographique PostGIS démarrée (streaming progressif)', 
          build: 'v2.4.0-unlimited-enrichment', 
          timestamp: new Date().toISOString() 
        }) + '\n');

        try {
          // Utiliser la nouvelle fonction streaming qui envoie chaque résultat via callback
          const stats = await searchByPolygonStreaming(
            polygon, 
            effectiveLimit,
            // Callback appelé pour CHAQUE propriétaire après enrichissement
            (result: ProprietaireResult, index: number, total: number) => {
              // Check if client is still connected before writing
              if (clientClosed) {
                return; // Skip writing, client disconnected
              }
              
              writeAndFlush(JSON.stringify({
                type: 'proprietaire',
                index: index + 1,
                total,
                data: {
                  proprietaire: result.proprietaire,
                  proprietes: result.proprietes,
                  entreprise: result.entreprise,
                  nombre_adresses: result.nombre_adresses,
                  nombre_lots: result.nombre_lots,
                  coordonnees: result.coordonnees,
                },
                timestamp: new Date().toISOString(),
              }) + '\n');
            }
          );

          // Only send summary if client is still connected
          if (!clientClosed) {
            // Envoyer le résumé final
            writeAndFlush(JSON.stringify({
              type: 'summary',
              success: true,
              query: {
                polygon_points: polygon.length,
                limit: limit || 'illimité',
              },
              stats: {
                total_proprietaires: stats.total_proprietaires,
                total_dans_polygone: stats.total_dans_polygone,
                total_lots: stats.total_lots,
                enriched_count: stats.enriched_count,
                geocoding_method: 'postgis_native',
                geocoding_coverage: '97.99%',
              },
              limites_appliquees: {
                max_resultats: effectiveLimit,
                max_enrichissement: 'illimité (streaming)',
              },
              debug: {
                wkt: stats.wkt.substring(0, 200) + '...',
                query_time_ms: stats.query_time_ms,
              },
              timestamp: new Date().toISOString(),
            }) + '\n');

            // Send completion message
            writeAndFlush(JSON.stringify({ 
              type: 'complete', 
              message: 'Recherche terminée avec succès', 
              timestamp: new Date().toISOString() 
            }) + '\n');
          }
        } catch (error) {
          console.error('Erreur recherche géographique (stream):', error);
          if (!clientClosed) {
            const incidentId = randomUUID().slice(0, 8);
            console.error(
              `[search/geo:stream] incident=${incidentId}`,
              error instanceof Error ? error.stack || error.message : error
            );
            writeAndFlush(JSON.stringify({
              type: 'error',
              success: false,
              error: 'Erreur interne du serveur',
              code: 'INTERNAL_ERROR',
              incident_id: incidentId,
              timestamp: new Date().toISOString(),
            }) + '\n');
          }
        } finally {
          // ALWAYS end the stream properly
          safeEnd();
        }
        return;
      }

      // Mode standard (non-streaming)
      try {
        const result = await searchByPolygon(polygon, effectiveLimit);

        const enrichissement = wantsEnrichment(request.body.enrich)
          ? await attachEnrichment(result.resultats as any)
          : null;

        return reply.send({
          success: true,
          query: {
            polygon_points: polygon.length,
            limit: limit || 'illimité',
          },
          enrichissement,
          count: result.total_proprietaires,
          proprietaires: result.resultats,
          total_proprietaires: result.total_proprietaires,
          total_lots: result.total_lots,
          stats: {
            geocoding_method: 'postgis_native',
            geocoding_coverage: '97.99%',
          },
          limites_appliquees: result.limites_appliquees,
          debug: result.debug,
        });
      } catch (error) {
        return sendServerError(reply, 'recherche géographique', error);
      }
    }
  );

  // Route: Recherche par rayon (cercle autour d'un point)
  fastify.post<{ Body: SearchByRadiusBody }>(
    '/search/geo/radius',
    { ...authHook },
    async (request: FastifyRequest<{ Body: SearchByRadiusBody }>, reply: FastifyReply) => {
      const { longitude, latitude, radius_meters, limit } = request.body;

      // Validation
      if (typeof longitude !== 'number' || typeof latitude !== 'number') {
        return reply.code(400).send({
          success: false,
          error: 'Coordonnées invalides',
          code: 'INVALID_COORDINATES',
          details: 'longitude et latitude doivent être des nombres',
        });
      }

      if (typeof radius_meters !== 'number' || radius_meters <= 0 || radius_meters > 50000) {
        return reply.code(400).send({
          success: false,
          error: 'Rayon invalide',
          code: 'INVALID_RADIUS',
          details: 'Le rayon doit être un nombre entre 1 et 50000 mètres',
        });
      }

      try {
        const result = await searchByRadius(longitude, latitude, radius_meters, limit || 1000);

        const enrichissement = wantsEnrichment(request.body.enrich)
          ? await attachEnrichment(result.resultats as any)
          : null;

        return reply.send({
          success: true,
          query: {
            longitude,
            latitude,
            radius_meters,
            limit: limit || 1000,
          },
          enrichissement,
          count: result.total_proprietaires,
          proprietaires: result.resultats,
          total_proprietaires: result.total_proprietaires,
          total_lots: result.total_lots,
          limites_appliquees: result.limites_appliquees,
        });
      } catch (error) {
        return sendServerError(reply, 'recherche par rayon', error);
      }
    }
  );

  // Route: Statistiques de géocodage
  fastify.get(
    '/search/geo/stats',
    { ...authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await getGeoStats();

        return reply.send({
          success: true,
          stats,
        });
      } catch (error) {
        return sendServerError(reply, 'stats géocodage', error);
      }
    }
  );

  // Route: Enrichissement de parcelles (EVF/DVF, BDNB, Copro)
  fastify.post(
    '/search/enrich',
    { ...authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { parcelles } = (request.body as any) || {};

      if (!parcelles || !Array.isArray(parcelles) || parcelles.length === 0) {
        return reply.code(400).send({
          success: false,
          error: 'Liste de parcelles requise',
          code: 'MISSING_PARCELLES',
          details: 'Le body doit contenir un champ "parcelles" (tableau de strings, format IDU 14 chars)',
        });
      }

      if (parcelles.length > 200) {
        return reply.code(400).send({
          success: false,
          error: 'Trop de parcelles',
          code: 'TOO_MANY_PARCELLES',
          details: 'Maximum 200 parcelles par requête',
        });
      }

      try {
        const { results: enrichmentMap, failures } = await enrichParcellesDetailed(parcelles);
        const results: Record<string, ParcelleEnrichment> = {};
        for (const [key, value] of enrichmentMap) {
          results[key] = value;
        }

        return reply.send({
          success: true,
          enrichissement: results,
          total: Object.keys(results).length,
          parcelles_demandees: parcelles.length,
          // Une source en echec n'est pas une absence de donnee : l'appelant
          // doit pouvoir afficher "indisponible" plutot qu'un resultat vide.
          sources_en_echec: failures,
        });
      } catch (error) {
        return sendServerError(reply, 'enrichissement', error);
      }
    }
  );
}
