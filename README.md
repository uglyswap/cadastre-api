# Cadastre API

API REST de recherche cadastrale française avec enrichissement des données entreprises.

## Fonctionnalités

- **Recherche par adresse** : Trouve les propriétaires d'un bien à partir d'une adresse (recherche fuzzy)
- **Recherche par SIREN** : Liste toutes les propriétés d'une entreprise
- **Recherche par dénomination** : Trouve les propriétaires par nom ou raison sociale
- **Enrichissement automatique** : Intégration avec l'API Recherche Entreprises (dirigeants, siège, effectifs)
- **Couverture nationale** : 101 départements, ~20 millions de propriétés
- **Authentification** : Protection par API key

## Stack Technique

- **Runtime** : Node.js 20+
- **Framework** : Fastify 5
- **Base de données** : PostgreSQL (données MAJIC)
- **Langage** : TypeScript
- **Enrichissement** : API Recherche Entreprises (api.gouv.fr)

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

## Endpoints API

### Routes publiques

#### `GET /`
Documentation de l'API.

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

### Routes protégées (API Key requise)

Toutes les routes ci-dessous nécessitent le header `X-API-Key`.

---

#### `GET /search/address`

Recherche de propriétaires par adresse.

**Paramètres :**
| Param | Type | Requis | Description |
|-------|------|--------|-------------|
| `adresse` | string | Oui | Texte de recherche (min 3 caractères) |
| `departement` | string | Non | Code département pour filtrer |
| `limit` | number | Non | Nombre max de résultats |

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

## Codes d'erreur

| Code | HTTP | Description |
|------|------|-------------|
| `MISSING_API_KEY` | 401 | Header X-API-Key manquant |
| `INVALID_API_KEY` | 403 | Clé API invalide |
| `MISSING_ADDRESS` | 400 | Paramètre adresse manquant |
| `INVALID_SIREN` | 400 | SIREN invalide (doit être 9 chiffres) |
| `MISSING_DENOMINATION` | 400 | Paramètre denomination manquant |
| `RATE_LIMIT_EXCEEDED` | 429 | Trop de requêtes |
| `INTERNAL_ERROR` | 500 | Erreur serveur |

## Structure des données

### Propriétaire
```typescript
{
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
{
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
  nombre_etablissements: number;
}
```

### Propriété
```typescript
{
  adresse: {
    numero: string;
    indice_repetition: string;  // bis, ter, etc.
    type_voie: string;          // Rue, Avenue, Boulevard...
    nom_voie: string;
    code_postal: string;
    commune: string;
    departement: string;
    adresse_complete: string;
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

## Déploiement Docker

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

## Déploiement Dokploy

1. Créer une nouvelle application depuis un repo Git
2. Sélectionner le Dockerfile
3. Configurer les variables d'environnement
4. Déployer

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
│   └── search.ts             # Logique de recherche
├── utils/
│   ├── abbreviations.ts      # Décodage des abréviations MAJIC
│   └── table-resolver.ts     # Résolution des tables par département
├── middleware/
│   └── auth.ts               # Validation des API keys
├── routes/
│   ├── health.ts             # Routes publiques
│   └── search.ts             # Routes de recherche
└── index.ts                  # Point d'entrée
```

## Base de données

La base contient les données MAJIC (fichiers des locaux) avec :
- 103 tables organisées par département
- Format : `pm_25_b_XXX` (XXX = code département)
- Cas spécial Paris : `pb_25_b_750_*`
- ~20 millions de lignes au total

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

## Rate Limiting

- **API interne** : 1000 requêtes/minute (configurable)
- **API Entreprises** : 7 requêtes/seconde (limite externe)

## Licence

ISC
