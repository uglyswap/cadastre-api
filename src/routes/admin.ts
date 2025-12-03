import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  checkPostGIS,
  checkBanTable,
  fullSetup,
  startBanImport,
  getImportState,
  createIndexes,
} from '../services/ban-setup.js';
import { getBanStats } from '../services/geo-search.js';
import { authHook } from '../middleware/auth.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  
  // Vérifier l'état du système BAN
  fastify.get(
    '/admin/ban/status',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const postgis = await checkPostGIS();
        const banTable = await checkBanTable();
        const importState = getImportState();
        const stats = await getBanStats();

        return reply.send({
          success: true,
          system: {
            postgis_installed: postgis.installed,
            postgis_version: postgis.version || null,
            ban_table_exists: banTable.exists,
            ban_adresses_count: banTable.count,
          },
          import: importState,
          stats,
          ready: postgis.installed && banTable.exists && banTable.count > 0,
          next_step: !postgis.installed
            ? 'Appelez POST /admin/ban/setup pour installer PostGIS'
            : !banTable.exists
            ? 'Appelez POST /admin/ban/setup pour créer la table'
            : banTable.count === 0
            ? 'Appelez POST /admin/ban/import pour importer la BAN'
            : 'Système prêt pour /search/geo',
        });
      } catch (error) {
        console.error('Erreur status BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors de la vérification',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Setup: installer PostGIS et créer la table BAN
  fastify.post(
    '/admin/ban/setup',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        console.log('[Admin] Démarrage setup BAN...');
        const result = await fullSetup();

        if (result.success) {
          return reply.send({
            success: true,
            message: 'Setup terminé avec succès',
            steps: result.steps,
            next_step: 'Appelez POST /admin/ban/import pour télécharger et importer la BAN (~30-60 min)',
          });
        } else {
          return reply.code(500).send({
            success: false,
            error: result.error,
            steps: result.steps,
          });
        }
      } catch (error) {
        console.error('Erreur setup BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors du setup',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Import: télécharger et importer la BAN (en arrière-plan)
  fastify.post(
    '/admin/ban/import',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        console.log('[Admin] Démarrage import BAN...');
        const result = await startBanImport();

        if (result.success) {
          return reply.send({
            success: true,
            message: result.message,
            check_progress: 'GET /admin/ban/status',
            estimated_time: '30-60 minutes',
          });
        } else {
          return reply.code(400).send({
            success: false,
            error: result.message,
          });
        }
      } catch (error) {
        console.error('Erreur import BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors du démarrage de l\'import',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Recréer les index (après import)
  fastify.post(
    '/admin/ban/reindex',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        console.log('[Admin] Recréation des index BAN...');
        const result = await createIndexes();

        return reply.send({
          success: result.success,
          message: result.message,
        });
      } catch (error) {
        console.error('Erreur reindex BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors de la création des index',
          details: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    }
  );

  // Stats BAN (raccourci)
  fastify.get(
    '/admin/ban/stats',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await getBanStats();
        const banTable = await checkBanTable();

        return reply.send({
          success: true,
          ban: {
            ...stats,
            total_in_table: banTable.count,
          },
          message: stats.postgis_installed
            ? banTable.count > 0
              ? `BAN prête avec ${banTable.count.toLocaleString()} adresses`
              : 'PostGIS installé, BAN non importée'
            : 'PostGIS non installé',
        });
      } catch (error) {
        console.error('Erreur stats BAN:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors de la récupération des stats',
        });
      }
    }
  );
}
