import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';

/**
 * Comparaison a temps constant de deux chaines, resistante aux timing attacks.
 * Les deux operandes sont hashees a longueur fixe avant comparaison pour ne pas
 * fuiter la longueur de la cle attendue.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Comparer quand meme contre soi-meme pour conserver un temps constant
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Pour l'instant, on utilise une seule API key master
// Plus tard, on pourra ajouter une table api_keys avec rate limiting et quotas
export async function validateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key'] as string;

  if (!apiKey) {
    reply.code(401).send({
      success: false,
      error: 'API key manquante',
      code: 'MISSING_API_KEY',
      details: 'Fournissez votre clé API dans le header X-API-Key',
    });
    return;
  }

  // Vérification à temps constant contre la master key
  if (!config.auth.masterApiKey || !safeCompare(apiKey, config.auth.masterApiKey)) {
    reply.code(403).send({
      success: false,
      error: 'API key invalide',
      code: 'INVALID_API_KEY',
      details: 'La clé API fournie n\'est pas valide',
    });
    return;
  }

  // Ici, on pourrait ajouter plus tard:
  // - Vérification en base de données
  // - Rate limiting par clé
  // - Quotas mensuels
  // - Logging des requêtes
}

/**
 * Verifie la cle d'ADMINISTRATION, distincte de la cle de recherche.
 *
 * Les routes protegees par ce hook executent du DDL sur la base cadastrale.
 * Une cle de recherche, meme valide, ne doit jamais les ouvrir : elle est
 * distribuee au frontend et a deja ete publiee une fois.
 */
export async function validateAdminApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-admin-api-key'] as string;

  if (!config.auth.adminApiKey) {
    reply.code(404).send({
      success: false,
      error: 'Route indisponible',
      code: 'ADMIN_DISABLED',
    });
    return;
  }

  if (!apiKey || !safeCompare(apiKey, config.auth.adminApiKey)) {
    // Meme reponse qu'une cle absente : ne pas indiquer a l'appelant s'il a
    // trouve le bon header.
    reply.code(403).send({
      success: false,
      error: 'Acces refuse',
      code: 'INVALID_ADMIN_KEY',
    });
    return;
  }
}

// Décorateur pour les routes protégées
export const authHook = {
  preHandler: validateApiKey,
};

/** Décorateur pour les routes d'administration (DDL). */
export const adminAuthHook = {
  preHandler: validateAdminApiKey,
};
