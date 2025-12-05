/**
 * DEPRECATED - Ce fichier réexporte depuis geo-search-postgis.ts
 * Utiliser directement geo-search-postgis.ts pour les nouvelles fonctionnalités
 * 
 * Ce fichier existe pour la compatibilité avec les anciens imports
 */

// Réexporter tout depuis le nouveau service PostGIS
export { searchByPolygon, getGeoStats, searchByRadius } from './geo-search-postgis.js';

// Alias pour la compatibilité
export { getGeoStats as getBanStats } from './geo-search-postgis.js';
