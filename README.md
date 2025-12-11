# Cadastre API

API REST de recherche cadastrale française avec enrichissement des données entreprises.

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Stack Technique](#stack-technique)
- [Installation](#installation)
- [Configuration](#configuration)
- [Endpoints API](#endpoints-api)
  - [Routes publiques](#routes-publiques)
  - [Routes de recherche](#routes-de-recherche)
  - [Routes géographiques](#routes-géographiques)
  - [Routes admin](#routes-admin)
- [Mode Streaming](#mode-streaming-ndjson)
- [Codes d'erreur](#codes-derreur)
- [Structure des données](#structure-des-données)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Déploiement](#déploiement)
- [Architecture](#architecture)
- [Base de données](#base-de-données)

---

## Fonctionnalités

| Fonctionnalité | Description |
|----------------|-------------|
| **Recherche par adresse** | Trouve les propriétaires d'un bien à partir d'une adresse (fuzzy matching) |
| **Recherche par SIREN** | Liste toutes les propriétés d'une entreprise |
| **Recherche par dénomination** | Trouve les propriétaires par nom ou raison sociale |
| **Recherche géographique** | Recherche par polygone ou rayon circulaire (PostGIS) |
| **Streaming NDJSON** | Résultats progressifs pour grandes requêtes géographiques |
| **Enrichissement automatique** | Intégration avec l'API Recherche Entreprises (dirigeants, siège, effectifs) |
| **Couverture nationale** | 101 départements, ~20 millions de propriétés, 22M+ adresses géocodées |
| **Authentification** | Protection par API key |

---

## Stack Technique

- **Runtime** : Node.js 20+
- **Framework** : Fastify 5
- **Base de données** : PostgreSQL + PostGIS
- **Langage** : TypeScript
- **Enrichissement** : API Recherche Entreprises (api.gouv.fr)

---

## Installation

```bash
# Cloner le repository
git clone https://github.com/uglyswap/cadastre-api.git
cd cadastre-api

# Installer les dépendances
npm install

# Configurer les variables d'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# Lancer en développement
npm run dev

# Compiler pour production
npm run build
npm start
```

---

## Configuration

Variables d'environnement (`.env`) :

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port du serveur | `3001` |
| `HOST` | Adresse d'écoute | `0.0.0.0` |
| `DB_HOST` | Hôte PostgreSQL | - |
| `DB_PORT` | Port PostgreSQL | `5432` |
| `DB_NAME` | Nom de la base | - |
| `DB_USER` | Utilisateur DB | - |
| `DB_PASSWORD` | Mot de passe DB | - |
| `MASTER_API_KEY` | Clé API principale | - |

---

## Endpoints API

### Routes publiques

#### `GET /`
Documentation de l'API.

---

#### `GET /health`
Vérification de l'état du serveur et de la connexion base de données.

**Réponse :**
```json
{
  "success": true,
  "status": "healthy",
  "database": "connected",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Codes HTTP :**
- `200` - Serveur sain
- `503` - Base de données déconnectée

---

#### `GET /departments`
Liste des départements disponibles dans la base.

**Réponse :**
```json
{
  "success": true,
  "departements": ["01", "02", "03", "...", "976"],
  "total": 101
}
```

---

### Routes de recherche

> **Authentification requise** : Header `X-API-Key`

---

#### `GET /search/address`

Recherche de propriétaires par adresse.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `adresse` | string | Oui | Texte de recherche (min 3 caractères) |
| `departement` | string | Non | Code département pour filtrer |
| `code_postal` | string | Non | Code postal pour filtrer |
| `limit` | number | Non | Nombre max de résultats (défaut: 50) |

**Exemple :**
```bash
curl "http://localhost:3001/search/address?adresse=champs%20elysees&departement=75" \
  -H "X-API-Key: votre_cle_api"
```

**Réponse :**
```json
{
  "success": true,
  "query": {
    "adresse": "champs elysees",
    "departement": "75"
  },
  "resultats": [
    {
      "proprietaire": {
        "siren": "123456789",
        "denomination": "SOCIETE EXEMPLE",
        "forme_juridique": "Société Anonyme",
        "type_droit": "Propriétaire"
      },
      "entreprise": {
        "siren": "123456789",
        "nom_complet": "SOCIETE EXEMPLE SA",
        "date_creation": "1990-01-01",
        "categorie_entreprise": "PME",
        "tranche_effectif": "50 à 99 salariés",
        "siege": {
          "adresse": "1 RUE EXEMPLE",
          "code_postal": "75001",
          "commune": "PARIS"
        },
        "dirigeants": [
          {
            "nom": "DUPONT",
            "prenoms": "JEAN",
            "qualite": "Président",
            "type": "personne_physique"
          }
        ]
      },
      "proprietes": [
        {
          "adresse": {
            "numero": "10",
            "type_voie": "Avenue",
            "nom_voie": "Des Champs Elysees",
            "commune": "PARIS 08",
            "adresse_complete": "10 Avenue Des Champs Elysees - PARIS 08 75"
          },
          "reference_cadastrale": {
            "departement": "75",
            "section": "AB",
            "numero_plan": "0001",
            "reference_complete": "75-108-AB-0001"
          },
          "localisation": {
            "batiment": "A",
            "entree": "01",
            "niveau": "02",
            "porte": "01001"
          }
        }
      ],
      "nombre_proprietes": 1
    }
  ],
  "total_proprietes": 1,
  "total_proprietaires": 1
}
```

---

#### `GET /search/siren`

Recherche de toutes les propriétés d'un propriétaire par SIREN.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `siren` | string | Oui | Numéro SIREN (9 chiffres) |
| `departement` | string | Non | Code département pour filtrer |

**Exemple :**
```bash
curl "http://localhost:3001/search/siren?siren=123456789" \
  -H "X-API-Key: votre_cle_api"
```

**Réponse :**
```json
{
  "success": true,
  "query": {
    "siren": "123456789",
    "departement": null
  },
  "proprietaire": { ... },
  "entreprise": { ... },
  "proprietes": [ ... ],
  "total_proprietes": 25,
  "departements_concernes": ["75", "92", "94"]
}
```

---

#### `GET /search/owner`

Recherche de propriétaires par nom ou dénomination.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `denomination` | string | Oui | Nom ou raison sociale (min 2 caractères) |
| `departement` | string | Non | Code département pour filtrer |
| `limit` | number | Non | Nombre max de résultats |

**Exemple :**
```bash
curl "http://localhost:3001/search/owner?denomination=carrefour&departement=75" \
  -H "X-API-Key: votre_cle_api"
```

---

### Routes géographiques

> **PostGIS requis** - Ces endpoints utilisent les fonctions géospatiales PostGIS sur 22M+ adresses géocodées.

---

#### `POST /search/geo`

Recherche par polygone géographique.

**Corps de la requête :**
```json
{
  "polygon": [
    { "longitude": 2.3522, "latitude": 48.8566 },
    { "longitude": 2.3622, "latitude": 48.8566 },
    { "longitude": 2.3622, "latitude": 48.8666 },
    { "longitude": 2.3522, "latitude": 48.8666 }
  ],
  "limit": 100,
  "stream": false
}
```

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `polygon` | array | Oui | Liste de points (min 3) avec `longitude` et `latitude` |
| `limit` | number | Non | Nombre max de résultats |
| `stream` | boolean | Non | Active le streaming NDJSON (défaut: false) |

**Exemple :**
```bash
curl -X POST "http://localhost:3001/search/geo" \
  -H "X-API-Key: votre_cle_api" \
  -H "Content-Type: application/json" \
  -d '{
    "polygon": [
      {"longitude": 2.3522, "latitude": 48.8566},
      {"longitude": 2.3622, "latitude": 48.8566},
      {"longitude": 2.3622, "latitude": 48.8666},
      {"longitude": 2.3522, "latitude": 48.8666}
    ],
    "limit": 50
  }'
```

**Réponse standard :**
```json
{
  "success": true,
  "data": {
    "proprietaires": [...],
    "stats": {
      "total_found": 150,
      "returned": 50,
      "geocoding_coverage": "98.5%"
    }
  }
}
```

---

#### `POST /search/geo/radius`

Recherche par rayon circulaire autour d'un point.

**Corps de la requête :**
```json
{
  "longitude": 2.3522,
  "latitude": 48.8566,
  "radius_meters": 500,
  "limit": 100
}
```

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `longitude` | number | Oui | Longitude du centre |
| `latitude` | number | Oui | Latitude du centre |
| `radius_meters` | number | Oui | Rayon en mètres (1 - 50000) |
| `limit` | number | Non | Nombre max de résultats |

**Exemple :**
```bash
curl -X POST "http://localhost:3001/search/geo/radius" \
  -H "X-API-Key: votre_cle_api" \
  -H "Content-Type: application/json" \
  -d '{
    "longitude": 2.3522,
    "latitude": 48.8566,
    "radius_meters": 1000,
    "limit": 50
  }'
```

**Réponse :**
```json
{
  "success": true,
  "query": {
    "center": { "longitude": 2.3522, "latitude": 48.8566 },
    "radius_meters": 1000
  },
  "resultats": [...],
  "total": 45
}
```

---

#### `GET /search/geo/stats`

Statistiques de géocodage PostGIS.

**Exemple :**
```bash
curl "http://localhost:3001/search/geo/stats" \
  -H "X-API-Key: votre_cle_api"
```

**Réponse :**
```json
{
  "success": true,
  "stats": {
    "total_addresses": 22500000,
    "geocoded": 22125000,
    "coverage_percent": 98.33,
    "postgis_version": "3.4.0",
    "spatial_index": "active"
  }
}
```

---

### Routes admin

> **Authentification admin requise** - Ces endpoints gèrent l'intégration de la Base d'Adresses Nationale (BAN).

---

#### `GET /admin/ban/status`

État du système BAN et PostGIS.

**Réponse :**
```json
{
  "success": true,
  "postgis_installed": true,
  "ban_table_exists": true,
  "total_addresses": 22500000,
  "next_steps": []
}
```

---

#### `POST /admin/ban/setup`

Installation de PostGIS et création de la table BAN.

**Réponse :**
```json
{
  "success": true,
  "steps_completed": [
    "PostGIS extension created",
    "BAN table created",
    "Spatial index created"
  ],
  "next_step": "Import BAN data via POST /admin/ban/import"
}
```

---

#### `POST /admin/ban/import`

Lance l'import des données BAN en arrière-plan.

> **Durée estimée :** 30-60 minutes

**Réponse :**
```json
{
  "success": true,
  "message": "BAN import started in background",
  "monitor_via": "GET /admin/ban/status"
}
```

---

#### `POST /admin/ban/reindex`

Reconstruit les index après l'import pour optimiser les performances.

**Réponse :**
```json
{
  "success": true,
  "indexes_rebuilt": ["ban_geom_idx", "ban_code_postal_idx"]
}
```

---

#### `GET /admin/ban/stats`

Statistiques rapides BAN.

**Réponse :**
```json
{
  "success": true,
  "ban_available": true,
  "total_addresses": 22500000,
  "message": "BAN data ready"
}
```

---

## Mode Streaming NDJSON

Pour les grandes zones géographiques, activez le streaming pour recevoir les résultats progressivement sans limite de taille.

### Activation

```bash
curl -X POST "http://localhost:3001/search/geo" \
  -H "X-API-Key: votre_cle_api" \
  -H "Content-Type: application/json" \
  -d '{"polygon": [...], "stream": true}'
```

### Format de réponse

Les résultats sont envoyés ligne par ligne au format NDJSON (Newline Delimited JSON) :

```
{"type":"start","total_estimated":500}
{"type":"result","data":{"proprietaire":{...},"propriete":{...}}}
{"type":"result","data":{"proprietaire":{...},"propriete":{...}}}
...
{"type":"end","total_sent":500,"duration_ms":1234}
```

### Avantages du streaming

| Avantage | Description |
|----------|-------------|
| **Pas de limite** | Nombre de résultats illimité |
| **Enrichissement illimité** | Pas de quota par requête |
| **Réponse rapide** | Premiers résultats reçus immédiatement |
| **Traitement progressif** | Possibilité de traiter les données au fur et à mesure |

### Exemple JavaScript (Node.js)

```javascript
const axios = require('axios');

async function searchGeoStream(polygon) {
  const response = await axios.post(
    'http://localhost:3001/search/geo',
    { polygon, stream: true },
    {
      headers: { 
        'X-API-Key': 'votre_cle_api',
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    }
  );
  
  response.data.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    lines.forEach(line => {
      const data = JSON.parse(line);
      if (data.type === 'result') {
        console.log('Propriétaire:', data.data.proprietaire.denomination);
      }
    });
  });
  
  response.data.on('end', () => {
    console.log('Streaming terminé');
  });
}
```

---

## Codes d'erreur

| Code | HTTP | Description |
|------|------|-------------|
| `MISSING_API_KEY` | 401 | Header X-API-Key manquant |
| `INVALID_API_KEY` | 403 | Clé API invalide |
| `MISSING_ADDRESS` | 400 | Paramètre adresse manquant |
| `INVALID_SIREN` | 400 | SIREN invalide (doit être 9 chiffres) |
| `MISSING_DENOMINATION` | 400 | Paramètre denomination manquant |
| `INVALID_POLYGON` | 400 | Polygone invalide (min 3 points requis) |
| `INVALID_RADIUS` | 400 | Rayon invalide (1 - 50000 mètres) |
| `RATE_LIMIT_EXCEEDED` | 429 | Trop de requêtes |
| `INTERNAL_ERROR` | 500 | Erreur serveur |

---

## Structure des données

### Propriétaire
```typescript
interface Proprietaire {
  siren: string;              // Numéro SIREN (9 chiffres)
  denomination: string;       // Nom ou raison sociale
  forme_juridique: string;    // Ex: "Société Anonyme", "SCI"
  forme_juridique_code: string;
  groupe: string;             // Type de personne morale
  type_droit: string;         // Ex: "Propriétaire", "Usufruitier"
  type_droit_code: string;
}
```

### Entreprise (enrichie)
```typescript
interface EntrepriseEnrichie {
  siren: string;
  nom_complet: string;
  nom_raison_sociale: string;
  sigle: string | null;
  nature_juridique: string;
  date_creation: string;
  etat_administratif: string;   // "A" = Active
  categorie_entreprise: string; // PME, ETI, GE
  tranche_effectif: string;
  siege: {
    adresse: string;
    code_postal: string;
    commune: string;
    latitude?: string;
    longitude?: string;
  };
  dirigeants: Dirigeant[];
  beneficiaires_effectifs?: BeneficiaireEffectif[];
  nombre_etablissements: number;
}
```

### Propriété
```typescript
interface Propriete {
  adresse: {
    numero: string;
    indice_repetition: string;  // bis, ter, etc.
    type_voie: string;          // Rue, Avenue, Boulevard...
    nom_voie: string;
    code_postal: string;
    commune: string;
    departement: string;
    adresse_complete: string;
    longitude?: number;         // Coordonnées GPS (si géocodé)
    latitude?: number;
  };
  reference_cadastrale: {
    departement: string;
    code_commune: string;
    prefixe: string | null;
    section: string;
    numero_plan: string;
    reference_complete: string;
  };
  localisation: {
    batiment: string;
    entree: string;
    niveau: string;
    porte: string;
  };
}
```

### Dirigeant
```typescript
interface Dirigeant {
  type: 'personne_physique' | 'personne_morale';
  nom?: string;
  prenoms?: string;
  denomination?: string;       // Si personne morale
  siren?: string;              // Si personne morale
  qualite: string;             // Président, DG, Gérant...
  date_naissance?: string;
}
```

---

## Exemples d'utilisation

### JavaScript / Node.js

```javascript
const axios = require('axios');

const API_URL = 'http://localhost:3001';
const API_KEY = 'votre_cle_api';

const headers = { 'X-API-Key': API_KEY };

// Recherche par adresse
async function searchByAddress(adresse, departement) {
  const response = await axios.get(`${API_URL}/search/address`, {
    params: { adresse, departement },
    headers
  });
  return response.data;
}

// Recherche par SIREN
async function searchBySiren(siren) {
  const response = await axios.get(`${API_URL}/search/siren`, {
    params: { siren },
    headers
  });
  return response.data;
}

// Recherche géographique par rayon
async function searchByRadius(longitude, latitude, radius_meters) {
  const response = await axios.post(
    `${API_URL}/search/geo/radius`,
    { longitude, latitude, radius_meters },
    { headers: { ...headers, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

// Utilisation
(async () => {
  const results = await searchByAddress('champs elysees', '75');
  console.log(`${results.total_proprietaires} propriétaires trouvés`);
})();
```

### Python

```python
import requests

API_URL = 'http://localhost:3001'
API_KEY = 'votre_cle_api'

headers = {'X-API-Key': API_KEY}

# Recherche par adresse
def search_by_address(adresse, departement=None):
    params = {'adresse': adresse}
    if departement:
        params['departement'] = departement
    response = requests.get(f'{API_URL}/search/address', params=params, headers=headers)
    return response.json()

# Recherche par SIREN
def search_by_siren(siren):
    response = requests.get(f'{API_URL}/search/siren', params={'siren': siren}, headers=headers)
    return response.json()

# Recherche par polygone
def search_by_polygon(polygon, limit=100):
    response = requests.post(
        f'{API_URL}/search/geo',
        json={'polygon': polygon, 'limit': limit},
        headers={**headers, 'Content-Type': 'application/json'}
    )
    return response.json()

# Recherche par rayon
def search_by_radius(longitude, latitude, radius_meters):
    response = requests.post(
        f'{API_URL}/search/geo/radius',
        json={'longitude': longitude, 'latitude': latitude, 'radius_meters': radius_meters},
        headers={**headers, 'Content-Type': 'application/json'}
    )
    return response.json()

# Streaming (générateur)
def search_geo_stream(polygon):
    response = requests.post(
        f'{API_URL}/search/geo',
        json={'polygon': polygon, 'stream': True},
        headers={**headers, 'Content-Type': 'application/json'},
        stream=True
    )
    for line in response.iter_lines():
        if line:
            yield json.loads(line)

# Utilisation
if __name__ == '__main__':
    results = search_by_address('rue de rivoli', '75')
    print(f"{results['total_proprietaires']} propriétaires trouvés")
```

### cURL

```bash
# Recherche par adresse
curl "http://localhost:3001/search/address?adresse=champs%20elysees&departement=75" \
  -H "X-API-Key: votre_cle_api"

# Recherche par SIREN
curl "http://localhost:3001/search/siren?siren=123456789" \
  -H "X-API-Key: votre_cle_api"

# Recherche par polygone
curl -X POST "http://localhost:3001/search/geo" \
  -H "X-API-Key: votre_cle_api" \
  -H "Content-Type: application/json" \
  -d '{
    "polygon": [
      {"longitude": 2.35, "latitude": 48.85},
      {"longitude": 2.36, "latitude": 48.85},
      {"longitude": 2.36, "latitude": 48.86},
      {"longitude": 2.35, "latitude": 48.86}
    ],
    "limit": 50
  }'

# Recherche par rayon (500m autour d'un point)
curl -X POST "http://localhost:3001/search/geo/radius" \
  -H "X-API-Key: votre_cle_api" \
  -H "Content-Type: application/json" \
  -d '{"longitude": 2.3522, "latitude": 48.8566, "radius_meters": 500}'
```

---

## Déploiement

### Docker

```bash
# Build
docker build -t cadastre-api .

# Run
docker run -d \
  -p 3001:3001 \
  -e DB_HOST=your_db_host \
  -e DB_PORT=5432 \
  -e DB_NAME=your_db_name \
  -e DB_USER=your_db_user \
  -e DB_PASSWORD=your_db_password \
  -e MASTER_API_KEY=your_api_key \
  cadastre-api
```

### Docker Compose

```yaml
version: '3.8'
services:
  cadastre-api:
    build: .
    ports:
      - "3001:3001"
    environment:
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_NAME=cadastre
      - DB_USER=postgres
      - DB_PASSWORD=secret
      - MASTER_API_KEY=your_api_key
    depends_on:
      - postgres

  postgres:
    image: postgis/postgis:16-3.4
    environment:
      - POSTGRES_DB=cadastre
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=secret
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

### Dokploy

1. Créer une nouvelle application depuis un repo Git
2. Sélectionner le Dockerfile
3. Configurer les variables d'environnement
4. Déployer

---

## Architecture

```
src/
├── config/
│   └── index.ts              # Configuration centralisée
├── types/
│   └── index.ts              # Types TypeScript
├── services/
│   ├── database.ts           # Pool de connexions PostgreSQL
│   ├── entreprises-api.ts    # Client API Entreprises avec rate limiting
│   ├── search.ts             # Logique de recherche standard
│   └── geo-search.ts         # Recherche géographique PostGIS
├── utils/
│   ├── abbreviations.ts      # Décodage des abréviations MAJIC
│   └── table-resolver.ts     # Résolution des tables par département
├── middleware/
│   └── auth.ts               # Validation des API keys
├── routes/
│   ├── health.ts             # Routes publiques
│   ├── search.ts             # Routes de recherche
│   └── admin.ts              # Routes administration BAN
└── index.ts                  # Point d'entrée
```

---

## Base de données

La base contient les données MAJIC (fichiers des locaux) avec :
- 103 tables organisées par département
- Format : `pm_25_b_XXX` (XXX = code département)
- Cas spécial Paris : `pb_25_b_750_*`
- ~20 millions de lignes au total
- Table `proprietaires_geo` : 22M+ adresses géocodées avec coordonnées PostGIS

### Colonnes principales

| Colonne | Description |
|---------|-------------|
| `département` | Code département |
| `nom_de_la_commune` | Nom de la commune |
| `section` | Section cadastrale |
| `n°_plan` | Numéro de plan |
| `n°_voirie` | Numéro de rue |
| `nature_voie` | Type de voie (RUE, AV, BD...) |
| `nom_voie` | Nom de la voie |
| `n°_siren` | SIREN du propriétaire |
| `dénomination` | Nom du propriétaire |
| `forme_juridique` | Forme juridique (SA, SCI...) |
| `code_droit` | Type de droit (P=Propriétaire...) |

### Index PostGIS

Pour les recherches géographiques, la table `proprietaires_geo` dispose d'un index spatial GIST sur la colonne `geom` :

```sql
CREATE INDEX proprietaires_geo_geom_idx ON proprietaires_geo USING GIST (geom);
```

---

## Rate Limiting

| Service | Limite |
|---------|--------|
| **API interne** | 1000 requêtes/minute (configurable) |
| **API Entreprises** | 7 requêtes/seconde (limite externe) |
| **Rayon géographique** | 1 - 50 000 mètres |
| **Points polygone** | Minimum 3 |

---

## Licence

ISC
