/**
 * Reponses d'erreur normalisees.
 *
 * Chaque handler renvoyait jusqu'ici `error.message` brut dans un champ
 * `details`, ce qui contournait le durcissement du gestionnaire global et
 * publiait au client les messages PostgreSQL : noms de tables, de colonnes,
 * de contraintes. C'est une cartographie gratuite du schema interne pour un
 * attaquant, et cela n'aide en rien l'utilisateur legitime.
 *
 * Le detail technique part desormais dans les logs serveur, correle au client
 * par un identifiant court que l'utilisateur peut communiquer au support.
 */

import { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

export interface ApiErrorBody {
  success: false;
  error: string;
  code: string;
  /** Identifiant a communiquer au support pour retrouver la trace serveur. */
  incident_id: string;
}

/**
 * Journalise l'erreur complete cote serveur et renvoie une reponse sans detail
 * technique. `context` situe l'appel dans les logs (ex: 'search/address').
 */
export function sendServerError(
  reply: FastifyReply,
  context: string,
  error: unknown,
  userMessage = 'Erreur interne du serveur'
): FastifyReply {
  const incidentId = randomUUID().slice(0, 8);
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[${context}] incident=${incidentId}`, detail);

  const body: ApiErrorBody = {
    success: false,
    error: userMessage,
    code: 'INTERNAL_ERROR',
    incident_id: incidentId,
  };
  return reply.code(500).send(body);
}

/**
 * Erreur de validation d'entree. Le message est ici volontairement explicite :
 * il decrit ce que l'appelant doit corriger, jamais l'etat interne du systeme.
 */
export function sendBadRequest(
  reply: FastifyReply,
  code: string,
  error: string,
  hint?: string
): FastifyReply {
  return reply.code(400).send({
    success: false,
    error,
    code,
    ...(hint ? { hint } : {}),
  });
}
