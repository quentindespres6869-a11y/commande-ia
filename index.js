const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
let twilioClient, deepgram;
try {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch(e) { console.log('Twilio non disponible'); }
try {
  const { createClient } = require('@deepgram/sdk');
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
} catch(e) { console.log('Deepgram non disponible'); }
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_RESTAURANTS = '2954180a10da476da3f20db69bd7bdbf';
const DB_EMPLOYES = '26a7bfc0e3b147aeae55e87dffeee763';
const ADMIN_EMAIL = 'quentin@commande-ia.fr';
const DB_MENUS = 'aa3d9c7174e641f2a82265a8fca8d251';
const DB_STOCKS = '2bab39532bb24fe3b874a7eb92415f8e';

const notionHeaders = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28'
};

// ─── PERSISTENCE ARCHIVES (par restaurant) ───────────
const ARCHIVES_DIR = path.join(__dirname, 'archives');
if (!fs.existsSync(ARCHIVES_DIR)) fs.mkdirSync(ARCHIVES_DIR);

// ─── MESSAGERIE (persistante par restaurant) ──────────
const MESSAGES_DIR = path.join(__dirname, 'messages');
if (!fs.existsSync(MESSAGES_DIR)) fs.mkdirSync(MESSAGES_DIR);

function msgFile(restaurantId) {
  const safe = (restaurantId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(MESSAGES_DIR, `messages_${safe}.json`);
}
function loadMessages(restaurantId) {
  try {
    const f = msgFile(restaurantId);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || [];
  } catch(e) {}
  return [];
}
function saveMessages(restaurantId, data) {
  try { fs.writeFileSync(msgFile(restaurantId), JSON.stringify(data, null, 2)); }
  catch(e) { console.log('Erreur sauvegarde messages:', e.message); }
}

// ─── BROADCASTS (persistants sur fichier) ─────────────
const BROADCASTS_FILE = path.join(__dirname, 'broadcasts.json');
function loadBroadcasts() {
  try { if (fs.existsSync(BROADCASTS_FILE)) return JSON.parse(fs.readFileSync(BROADCASTS_FILE, 'utf8')) || []; }
  catch(e) {}
  return [];
}
function saveBroadcasts(data) {
  try { fs.writeFileSync(BROADCASTS_FILE, JSON.stringify(data, null, 2)); }
  catch(e) {}
}

function archiveFile(restaurantId) {
  const safe = (restaurantId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(ARCHIVES_DIR, `archives_${safe}.json`);
}
function loadArchivesForRestaurant(restaurantId) {
  try {
    const file = archiveFile(restaurantId);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch(e) { console.log('Erreur lecture archives:', e.message); }
  return [];
}
function saveArchivesForRestaurant(restaurantId, data) {
  try { fs.writeFileSync(archiveFile(restaurantId), JSON.stringify(data, null, 2)); }
  catch(e) { console.log('Erreur sauvegarde archives:', e.message); }
}

// Migration: si ancien archives.json existe, le distribuer par restaurant
function migrateOldArchives() {
  const oldFile = path.join(__dirname, 'archives.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8')) || [];
    const byRestaurant = {};
    old.forEach(a => {
      const rid = a.restaurantId || 'global';
      if (!byRestaurant[rid]) byRestaurant[rid] = [];
      byRestaurant[rid].push(a);
    });
    Object.entries(byRestaurant).forEach(([rid, data]) => {
      const file = archiveFile(rid);
      if (!fs.existsSync(file)) saveArchivesForRestaurant(rid, data);
    });
    fs.renameSync(oldFile, oldFile + '.migrated');
    console.log('Archives migrées par restaurant.');
  } catch(e) { console.log('Erreur migration archives:', e.message); }
}
migrateOldArchives();

function todayStr() { return new Date().toISOString().split('T')[0]; }

// archives en mémoire : indexé par restaurantId pour le temps réel
const archivesMemory = {}; // { restaurantId: [...] }
function getMemoryArchives(restaurantId) {
  const rid = restaurantId || 'global';
  if (!archivesMemory[rid]) {
    archivesMemory[rid] = loadArchivesForRestaurant(rid);
  }
  return archivesMemory[rid];
}

let commandes = [], nextId = 1;
// Calculer le prochain ID en lisant tous les fichiers d'archives
try {
  const files = fs.readdirSync(ARCHIVES_DIR).filter(f => f.endsWith('.json'));
  let maxId = 0;
  files.forEach(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ARCHIVES_DIR, f), 'utf8')) || [];
      data.forEach(a => { if ((a.id || 0) > maxId) maxId = a.id; });
    } catch(e) {}
  });
  if (maxId >= nextId) nextId = maxId + 1;
} catch(e) {}

// Sessions vocales (déclaré ICI, avant les routes)
const voiceSessions = {};

// ─── HELPERS STOCK / INGRÉDIENTS ─────────────────────

/**
 * Parse une chaîne d'ingrédients avec quantités optionnelles.
 * Formats acceptés : "2 viande 10:1", "3x fromage", "pain", "2.5 sauce"
 * Retourne [{nom, qty}] dédupliqués.
 */
function parseIngredientsWithQty(str) {
  if (!str || !str.trim()) return [];
  const seen = new Set();
  const result = [];
  str.split(/[,;\n]+/).forEach(part => {
    part = part.trim();
    if (part.length < 2) return;
    // Détecter un préfixe numérique : "2 pain", "3x fromage", "2.5 sauce" — le nom doit commencer par une lettre
    const m = part.match(/^(\d+(?:[.,]\d+)?)\s*[xX×]?\s*([a-zA-ZÀ-ÿ\u0080-\uFFFF].+)$/);
    const qty = m ? parseFloat(m[1].replace(',', '.')) || 1 : 1;
    const nom = m ? m[2].trim() : part.trim();
    const key = nom.toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({ nom, qty });
  });
  return result;
}

/**
 * Parse une chaîne d'ingrédients séparés par virgule/point-virgule/retour à la ligne.
 * Retourne un tableau de noms nettoyés et dédupliqués (casse ignorée) — sans quantités.
 */
function parseIngredients(str) {
  return parseIngredientsWithQty(str).map(i => i.nom);
}

/**
 * Pour un produit donné (nom + ingrédients), crée dans Notion Stock
 * les entrées manquantes (1 unité par ingrédient, sans doublon).
 * Retourne { created: [...], skipped: [...] }
 */
async function syncIngredientStock(ingredientsStr, restaurant, restaurantId) {
  const ingredients = parseIngredients(ingredientsStr);
  if (!ingredients.length || !restaurantId) return { created: [], skipped: [] };

  // Récupérer le stock existant pour ce restaurant
  const existingRes = await fetch(`https://api.notion.com/v1/databases/${DB_STOCKS}/query`, {
    method: 'POST', headers: notionHeaders,
    body: JSON.stringify({
      filter: { property: 'Restaurant ID', rich_text: { equals: restaurantId } }
    })
  });
  const existingData = await existingRes.json();

  // Map nom (lowercase) → page id
  const existingMap = {};
  for (const p of (existingData.results || [])) {
    const nom = p.properties['Produit']?.title?.[0]?.plain_text || '';
    if (nom) existingMap[nom.toLowerCase().trim()] = p.id;
  }

  const created = [], skipped = [];

  for (const ingredient of ingredients) {
    const key = ingredient.toLowerCase().trim();
    if (existingMap[key]) {
      skipped.push(ingredient);
      continue;
    }
    // Créer l'ingrédient dans le stock
    await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_STOCKS },
        properties: {
          'Produit':              { title: [{ text: { content: ingredient } }] },
          'Quantité actuelle':    { number: 1 },
          'Quantité initiale':    { number: 1 },
          'Seuil alerte':         { number: 1 },
          'Unité':                { select: { name: 'unité' } },
          'Statut':               { select: { name: 'Disponible' } },
          'Restaurant':           { rich_text: [{ text: { content: restaurant || '' } }] },
          'Restaurant ID':        { rich_text: [{ text: { content: restaurantId || '' } }] },
          'Dernière mise à jour': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] }
        }
      })
    });
    existingMap[key] = true; // évite les doublons dans le même batch
    created.push(ingredient);
  }

  console.log(`syncIngredientStock [${restaurant}] — créés: ${created.length} (${created.join(', ')}), ignorés: ${skipped.length}`);
  return { created, skipped };
}

function hashPassword(pwd) { return crypto.createHash('sha256').update(pwd).digest('hex'); }
function generatePassword() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

// ─── COMMANDES ───────────────────────────────────────

app.get('/commandes', (req, res) => res.json(commandes));

app.get('/archives', (req, res) => {
  const { date, restaurantId } = req.query;
  const data = getMemoryArchives(restaurantId);
  const today = todayStr();
  const filterDate = date || today;
  res.json(data.filter(a => (a.archivedDate || today) === filterDate));
});

app.get('/archives/dates', (req, res) => {
  const { restaurantId } = req.query;
  const data = getMemoryArchives(restaurantId);
  const dates = [...new Set(data.map(a => a.archivedDate).filter(Boolean))].sort().reverse();
  res.json(dates);
});

app.post('/commandes', (req, res) => {
  const cmd = { id: nextId++, ...req.body, state: 'new', chronoStart: null, chronoEnd: null, createdAt: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) };
  commandes.push(cmd); io.emit('nouvelle_commande', cmd); res.json(cmd);
});

app.patch('/commandes/:id/valider', async (req, res) => {
  const cmd = commandes.find(c => c.id === parseInt(req.params.id));
  if (!cmd) return res.status(404).json({ error: 'Introuvable' });
  cmd.state = 'validated'; cmd.chronoStart = Date.now();
  io.emit('commande_mise_a_jour', cmd);

  if (cmd.restaurantId) {
    try {
      // ── Étape 1 : Récupérer les produits commandés depuis le menu ──
      const menuRes = await fetch(`https://api.notion.com/v1/databases/${DB_MENUS}/query`, {
        method: 'POST', headers: notionHeaders,
        body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: cmd.restaurantId } } })
      });
      const menuData = await menuRes.json();

      // Construire une map nomProduit → [{nom, qty}] (avec multiplicateurs de quantité)
      const menuMap = {};
      for (const p of (menuData.results || [])) {
        const nom = p.properties['Nom du produit']?.title?.[0]?.plain_text || '';
        const ing = p.properties['Ingrédients']?.rich_text?.[0]?.plain_text || '';
        if (nom) menuMap[nom.toLowerCase().trim()] = parseIngredientsWithQty(ing);
      }

      // ── Étape 2 : Identifier les produits et leurs modifications ──
      const ingredientsADeduire = new Map(); // nomIngredient → quantité à déduire

      // Fonction : trouver la clé dans menuMap (exacte → nettoyée → préfixe)
      function findMenuKey(rawToken) {
        const clean = rawToken.replace(/\s*\(.*?\)\s*/g, '').trim();
        if (Object.prototype.hasOwnProperty.call(menuMap, rawToken)) return rawToken;
        if (clean !== rawToken && Object.prototype.hasOwnProperty.call(menuMap, clean)) return clean;
        return Object.keys(menuMap).find(k =>
          (rawToken.startsWith(k + ' ') || clean.startsWith(k + ' ')) && k.length >= 3
        ) || null;
      }

      // Fonction : parser "sans cornichon, sans oignon" → Set d'ingrédients exclus
      function parseExclus(modificationsStr) {
        const exclu = new Set();
        if (!modificationsStr) return exclu;
        modificationsStr.toLowerCase().split(/[,;]+/).forEach(part => {
          const p = part.trim();
          // "sans cornichon" ou "sans les cornichons" ou "no pickles"
          const m = p.match(/^(?:sans|no|without)\s+(?:les?\s+|de\s+)?(.+)$/);
          if (m) exclu.add(m[1].trim().replace(/s$/, '')); // retire le pluriel final
        });
        return exclu;
      }

      // Chemin 1 — panierRaw disponible : déduction précise article par article
      const panierBrut = Array.isArray(cmd.panierRaw) ? cmd.panierRaw : [];

      if (panierBrut.length > 0) {
        for (const item of panierBrut) {
          const nomLow = (item.nom || '').toLowerCase().trim();
          const matchKey = findMenuKey(nomLow);
          if (!matchKey) {
            console.log(`[Stock] Produit "${nomLow}" non trouvé dans le menu — ignoré`);
            continue;
          }
          const qteCommande = item.quantite || 1; // nombre de fois ce produit est commandé
          const exclus = parseExclus(item.modifications || '');

          for (const ing of menuMap[matchKey]) {
            // ing = { nom, qty } — qty = multiplicateur de l'ingrédient dans la recette
            const ingNom = ing.nom || ing; // rétro-compat si jamais string
            const ingQtyRecette = ing.qty || 1;
            const ingKey = ingNom.toLowerCase().trim();
            // Vérifier si cet ingrédient est exclu par les modifications du client
            const estExclu = exclus.size > 0 && [...exclus].some(ex => ingKey.includes(ex) || ex.includes(ingKey));
            if (estExclu) {
              console.log(`[Stock] "${ingNom}" exclu (modif: "${item.modifications}") — non déduit`);
              continue;
            }
            // Déduire : qté recette × qté commandée (ex: 3x Big Mac avec 2 viandes = 6 viandes)
            const totalADeduire = ingQtyRecette * qteCommande;
            console.log(`[Stock] ${ingNom}: -${totalADeduire} (${ingQtyRecette} recette × ${qteCommande} commandé)`);
            ingredientsADeduire.set(ingKey, (ingredientsADeduire.get(ingKey) || 0) + totalADeduire);
          }
        }
      } else {
        // Chemin 2 — Fallback : utiliser les champs formatés (commandes manuelles sans panierRaw)
        // Tenter de parser cmd.modif pour les exclusions globales
        const exclusGlobal = parseExclus(cmd.modif || '');

        const champsCommande = [cmd.sandwich, cmd.boisson, cmd.accompagnement, cmd.dessert, cmd.option].filter(Boolean);
        for (const champ of champsCommande) {
          const tokens = champ.split(/[,|]+/).map(s => s.trim().replace(/^\d+x\s*/i, '').toLowerCase());
          for (const token of tokens) {
            if (!token) continue;
            const matchKey = findMenuKey(token);
            if (!matchKey) {
              console.log(`[Stock] Produit "${token}" non trouvé dans le menu — ignoré`);
              continue;
            }
            for (const ing of menuMap[matchKey]) {
              const ingNom = ing.nom || ing;
              const ingQtyRecette = ing.qty || 1;
              const ingKey = ingNom.toLowerCase().trim();
              const estExclu = exclusGlobal.size > 0 && [...exclusGlobal].some(ex => ingKey.includes(ex) || ex.includes(ingKey));
              if (estExclu) {
                console.log(`[Stock] "${ingNom}" exclu (modif global) — non déduit`);
                continue;
              }
              ingredientsADeduire.set(ingKey, (ingredientsADeduire.get(ingKey) || 0) + ingQtyRecette);
            }
          }
        }
      }

      if (ingredientsADeduire.size === 0) {
        console.log('Aucun ingrédient trouvé pour cette commande, déduction stock ignorée');
      } else {
        // ── Étape 3 : Récupérer le stock et déduire ──
        const stockRes = await fetch(`https://api.notion.com/v1/databases/${DB_STOCKS}/query`, {
          method: 'POST', headers: notionHeaders,
          body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: cmd.restaurantId } } })
        });
        const stockData = await stockRes.json();

        for (const stockPage of (stockData.results || [])) {
          const nomStock = stockPage.properties['Produit']?.title?.[0]?.plain_text || '';
          const nomStockKey = nomStock.toLowerCase().trim();
          const qteADeduire = ingredientsADeduire.get(nomStockKey) || 0;
          if (!qteADeduire) continue;

          const qtyActuelle = stockPage.properties['Quantité actuelle']?.number ?? 0;
          const seuilAlerte = stockPage.properties['Seuil alerte']?.number || 1;
          const newQty = Math.max(0, qtyActuelle - qteADeduire);
          const statut = newQty <= 0 ? 'Rupture' : newQty <= seuilAlerte ? 'Alerte' : 'Disponible';

          await fetch(`https://api.notion.com/v1/pages/${stockPage.id}`, {
            method: 'PATCH', headers: notionHeaders,
            body: JSON.stringify({
              properties: {
                'Quantité actuelle': { number: newQty },
                'Statut':            { select: { name: statut } },
                'Dernière mise à jour': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] }
              }
            })
          });
          console.log(`Stock ingrédient déduit : ${nomStock} ${qtyActuelle} → ${newQty} (${statut})`);
        }
      }
    } catch (e) { console.log('Erreur déduction stock ingrédients:', e.message); }
  }

  res.json(cmd);
});

app.patch('/commandes/:id/prete', (req, res) => {
  const idx = commandes.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  const cmd = commandes[idx];
  cmd.state = 'done'; cmd.chronoEnd = Date.now();
  cmd.archivedAt = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  cmd.archivedDate = todayStr();
  const rid = cmd.restaurantId || 'global';
  const restArchives = getMemoryArchives(rid);
  restArchives.unshift(cmd);
  saveArchivesForRestaurant(rid, restArchives);
  commandes.splice(idx, 1);
  io.emit('commande_terminee', cmd); res.json(cmd);
});

app.patch('/commandes/:id/refuser', (req, res) => {
  const idx = commandes.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  const cmd = commandes[idx];
  cmd.state = 'refused';
  cmd.archivedAt = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  cmd.archivedDate = todayStr();
  const rid = cmd.restaurantId || 'global';
  const restArchives = getMemoryArchives(rid);
  restArchives.unshift(cmd);
  saveArchivesForRestaurant(rid, restArchives);
  commandes.splice(idx, 1);
  io.emit('commande_terminee', cmd); res.json(cmd);
});

// ─── AUTH ─────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_EMPLOYES}/query`, {
      method: 'POST', headers: notionHeaders, body: JSON.stringify({})
    });
    const data = await r.json();
    if (!data.results?.length) return res.status(401).json({ error: 'Compte introuvable' });
    const page = data.results.find(p => p.properties['Email']?.email === email);
    if (!page) return res.status(401).json({ error: 'Compte introuvable' });
    const props = page.properties;
    const storedPwd = props['Mot de passe']?.rich_text?.[0]?.plain_text;
    const statut = props['Statut']?.select?.name;
    if (statut === 'Suspendu') return res.status(403).json({ error: 'Compte suspendu' });
    const roleFromNotion = props['Rôle']?.select?.name;
    if (roleFromNotion === 'Admin' && email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    if (storedPwd !== hashPassword(password)) return res.status(401).json({ error: 'Mot de passe incorrect' });
    await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ properties: { 'Dernière connexion': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] } } })
    });
    res.json({
      success: true,
      user: {
        id: page.id,
        nom: props['Nom']?.title?.[0]?.plain_text,
        email: props['Email']?.email,
        role: props['Rôle']?.select?.name,
        restaurant: props['Restaurant']?.rich_text?.[0]?.plain_text,
        restaurantId: props['Restaurant ID']?.rich_text?.[0]?.plain_text
      }
    });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── RESTAURANTS ──────────────────────────────────────

app.get('/admin/restaurants', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_RESTAURANTS}/query`, {
      method: 'POST', headers: notionHeaders, body: JSON.stringify({})
    });
    const data = await r.json();
    if (!data.results) return res.json([]);
    res.json(data.results.map(p => ({
      id: p.id,
      nom: p.properties['Nom du restaurant']?.title?.[0]?.plain_text,
      email: p.properties['Email']?.email,
      telephone: p.properties['Téléphone']?.phone_number,
      statut: p.properties['Statut']?.select?.name,
      abonnement: p.properties['Abonnement']?.select?.name,
      twilio: p.properties['Numéro Twilio']?.rich_text?.[0]?.plain_text,
      notes: p.properties['Notes']?.rich_text?.[0]?.plain_text,
      onboarding: p.properties['Onboarding']?.select?.name,
      menuComplete: p.properties['Menu complété']?.checkbox,
      adresse: p.properties['Adresse']?.rich_text?.[0]?.plain_text
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/restaurants', async (req, res) => {
  const { nom, email, telephone, abonnement, adresse, notes } = req.body;
  if (!nom || !email) return res.status(400).json({ error: 'Nom et email requis' });
  const pwd = generatePassword();
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_RESTAURANTS },
        properties: {
          'Nom du restaurant': { title: [{ text: { content: nom } }] },
          'Email': { email: email },
          'Téléphone': { phone_number: telephone || '' },
          'Mot de passe': { rich_text: [{ text: { content: hashPassword(pwd) } }] },
          'Statut': { select: { name: 'Actif' } },
          'Abonnement': { select: { name: abonnement || 'Mensuel' } },
          'Notes': { rich_text: [{ text: { content: notes || '' } }] },
          'Adresse': { rich_text: [{ text: { content: adresse || '' } }] },
          'Onboarding': { select: { name: 'À compléter' } },
          'Menu complété': { checkbox: false }
        }
      })
    });
    const page = await r.json();
    console.log('Restaurant créé:', page.id, page.message);
    if (page.object === 'error') return res.status(500).json({ error: page.message });
    res.json({ success: true, id: page.id, nom, email, motDePasse: pwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/admin/restaurants/:id/statut', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ properties: { 'Statut': { select: { name: req.body.statut } } } })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.patch('/admin/restaurants/:id/infos', async (req, res) => {
  const { adresse, twilio, horaires, onboarding, menuComplete } = req.body;
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({
        properties: {
          'Adresse': { rich_text: [{ text: { content: adresse || '' } }] },
          'Numéro Twilio': { rich_text: [{ text: { content: twilio || '' } }] },
          'Notes': { rich_text: [{ text: { content: horaires || '' } }] },
          'Onboarding': { select: { name: onboarding || 'En cours' } },
          'Menu complété': { checkbox: menuComplete || false }
        }
      })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.get('/mon-restaurant/:id', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, { headers: notionHeaders });
    const page = await r.json();
    const props = page.properties;
    res.json({
      id: page.id,
      nom: props['Nom du restaurant']?.title?.[0]?.plain_text,
      email: props['Email']?.email,
      telephone: props['Téléphone']?.phone_number,
      statut: props['Statut']?.select?.name,
      abonnement: props['Abonnement']?.select?.name,
      twilio: props['Numéro Twilio']?.rich_text?.[0]?.plain_text,
      horaires: props['Notes']?.rich_text?.[0]?.plain_text,
      adresse: props['Adresse']?.rich_text?.[0]?.plain_text,
      onboarding: props['Onboarding']?.select?.name,
      menuComplete: props['Menu complété']?.checkbox
    });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ─── EMPLOYES ─────────────────────────────────────────

app.get('/admin/employes', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_EMPLOYES}/query`, {
      method: 'POST', headers: notionHeaders, body: JSON.stringify({})
    });
    const data = await r.json();
    res.json(data.results.map(p => ({
      id: p.id,
      nom: p.properties['Nom']?.title?.[0]?.plain_text,
      email: p.properties['Email']?.email,
      role: p.properties['Rôle']?.select?.name,
      restaurant: p.properties['Restaurant']?.rich_text?.[0]?.plain_text,
      restaurantId: p.properties['Restaurant ID']?.rich_text?.[0]?.plain_text,
      statut: p.properties['Statut']?.select?.name,
      derniereConnexion: p.properties['Dernière connexion']?.rich_text?.[0]?.plain_text
    })));
  } catch (e) { res.status(500).json({ error: 'Erreur récupération' }); }
});

app.post('/admin/employes', async (req, res) => {
  const { nom, email, role, restaurant, restaurantId } = req.body;
  if (!nom || !email || !role) return res.status(400).json({ error: 'Champs requis manquants' });
  const pwd = generatePassword();
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_EMPLOYES },
        properties: {
          'Nom': { title: [{ text: { content: nom } }] },
          'Email': { email: email },
          'Mot de passe': { rich_text: [{ text: { content: hashPassword(pwd) } }] },
          'Rôle': { select: { name: role } },
          'Restaurant': { rich_text: [{ text: { content: restaurant || '' } }] },
          'Restaurant ID': { rich_text: [{ text: { content: restaurantId || '' } }] },
          'Statut': { select: { name: 'Actif' } }
        }
      })
    });
    const page = await r.json();
    res.json({ success: true, id: page.id, nom, email, role, motDePasse: pwd });
  } catch (e) { res.status(500).json({ error: 'Erreur création employé' }); }
});

app.patch('/admin/employes/:id/statut', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ properties: { 'Statut': { select: { name: req.body.statut } } } })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ─── MENUS ────────────────────────────────────────────

app.get('/admin/menus', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_MENUS}/query`, {
      method: 'POST', headers: notionHeaders, body: JSON.stringify({})
    });
    const data = await r.json();
    res.json(data.results.map(p => ({
      id: p.id,
      nom: p.properties['Nom du produit']?.title?.[0]?.plain_text,
      categorie: p.properties['Catégorie']?.select?.name,
      prix: p.properties['Prix']?.number,
      prixMenu: p.properties['Prix menu']?.number,
      dispoMenu: p.properties['Disponible en menu']?.checkbox,
      description: p.properties['Description']?.rich_text?.[0]?.plain_text,
      ingredients: p.properties['Ingrédients']?.rich_text?.[0]?.plain_text,
      ingredientsRetirables: p.properties['Ingrédients retirables']?.rich_text?.[0]?.plain_text,
      allergenes: p.properties['Allergènes']?.multi_select?.map(a => a.name) || [],
      tempsPrepare: p.properties['Temps de préparation']?.number,
      disponible: p.properties['Disponible']?.checkbox,
      restaurant: p.properties['Restaurant']?.rich_text?.[0]?.plain_text,
      restaurantId: p.properties['Restaurant ID']?.rich_text?.[0]?.plain_text
    })));
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/admin/menus', async (req, res) => {
  const { nom, categorie, prix, prixMenu, dispoMenu, description, ingredients, ingredientsRetirables, allergenes, restaurant, restaurantId, tempsPrepare } = req.body;
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_MENUS },
        properties: {
          'Nom du produit': { title: [{ text: { content: nom } }] },
          'Catégorie': { select: { name: categorie || 'Sandwich' } },
          'Prix': { number: parseFloat(prix) || 0 },
          'Prix menu': { number: parseFloat(prixMenu) || 0 },
          'Disponible en menu': { checkbox: dispoMenu === true || dispoMenu === 'true' },
          'Description': { rich_text: [{ text: { content: description || '' } }] },
          'Ingrédients': { rich_text: [{ text: { content: ingredients || '' } }] },
          'Ingrédients retirables': { rich_text: [{ text: { content: ingredientsRetirables || '' } }] },
          'Allergènes': { multi_select: (allergenes || []).map(a => ({ name: a })) },
          'Temps de préparation': { number: parseInt(tempsPrepare) || 0 },
          'Disponible': { checkbox: true },
          'Restaurant': { rich_text: [{ text: { content: restaurant || '' } }] },
          'Restaurant ID': { rich_text: [{ text: { content: restaurantId || '' } }] }
        }
      })
    });
    const page = await r.json();
    if (page.object === 'error') return res.status(500).json({ error: page.message });

    // ── Sync automatique des ingrédients dans le stock ──
    let stockSync = { created: [], skipped: [] };
    if (ingredients && restaurantId) {
      try { stockSync = await syncIngredientStock(ingredients, restaurant, restaurantId); }
      catch (e) { console.log('Erreur sync stock ingrédients:', e.message); }
    }

    res.json({ success: true, id: page.id, stockSync });
  } catch (e) { res.status(500).json({ error: 'Erreur création produit' }); }
});

// ─── PATCH menu (modification) ────────────────────────
app.patch('/admin/menus/:id', async (req, res) => {
  const { nom, categorie, prix, prixMenu, dispoMenu, description, ingredients, ingredientsRetirables, allergenes, restaurant, restaurantId, tempsPrepare, disponible } = req.body;
  try {
    const props = {};
    if (nom !== undefined)                props['Nom du produit']          = { title: [{ text: { content: nom } }] };
    if (categorie !== undefined)          props['Catégorie']               = { select: { name: categorie } };
    if (prix !== undefined)               props['Prix']                    = { number: parseFloat(prix) || 0 };
    if (prixMenu !== undefined)           props['Prix menu']               = { number: parseFloat(prixMenu) || 0 };
    if (dispoMenu !== undefined)          props['Disponible en menu']      = { checkbox: dispoMenu === true || dispoMenu === 'true' };
    if (description !== undefined)        props['Description']             = { rich_text: [{ text: { content: description || '' } }] };
    if (ingredients !== undefined)        props['Ingrédients']             = { rich_text: [{ text: { content: ingredients || '' } }] };
    if (ingredientsRetirables !== undefined) props['Ingrédients retirables'] = { rich_text: [{ text: { content: ingredientsRetirables || '' } }] };
    if (allergenes !== undefined)         props['Allergènes']              = { multi_select: (allergenes || []).map(a => ({ name: a })) };
    if (tempsPrepare !== undefined)       props['Temps de préparation']    = { number: parseInt(tempsPrepare) || 0 };
    if (disponible !== undefined)         props['Disponible']              = { checkbox: disponible === true || disponible === 'true' };

    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ properties: props })
    });

    // ── Sync les NOUVEAUX ingrédients éventuels dans le stock ──
    let stockSync = { created: [], skipped: [] };
    if (ingredients && restaurantId) {
      try { stockSync = await syncIngredientStock(ingredients, restaurant, restaurantId); }
      catch (e) { console.log('Erreur sync stock edit:', e.message); }
    }

    res.json({ success: true, stockSync });
  } catch (e) { res.status(500).json({ error: 'Erreur modification produit' }); }
});

app.delete('/admin/menus/:id', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ archived: true })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

app.get('/mon-menu/:restaurantId', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_MENUS}/query`, {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: req.params.restaurantId } } })
    });
    const data = await r.json();
    res.json(data.results.map(p => ({
      id: p.id,
      nom: p.properties['Nom du produit']?.title?.[0]?.plain_text,
      categorie: p.properties['Catégorie']?.select?.name,
      prix: p.properties['Prix']?.number,
      prixMenu: p.properties['Prix menu']?.number,
      dispoMenu: p.properties['Disponible en menu']?.checkbox,
      ingredients: p.properties['Ingrédients']?.rich_text?.[0]?.plain_text,
      ingredientsRetirables: p.properties['Ingrédients retirables']?.rich_text?.[0]?.plain_text,
      allergenes: p.properties['Allergènes']?.multi_select?.map(a => a.name) || [],
      tempsPrepare: p.properties['Temps de préparation']?.number,
      disponible: p.properties['Disponible']?.checkbox
    })));
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/admin/restaurants/:id', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ archived: true })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

app.delete('/admin/employes/:id', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ archived: true })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ─── STOCKS ──────────────────────────────────────────

app.get('/stocks/:restaurantId', async (req, res) => {
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB_STOCKS}/query`, {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: req.params.restaurantId } } })
    });
    const data = await r.json();
    if (!data.results) return res.json([]);
    res.json(data.results.map(p => ({
      id: p.id,
      produit: p.properties['Produit']?.title?.[0]?.plain_text,
      quantiteActuelle: p.properties['Quantité actuelle']?.number,
      quantiteInitiale: p.properties['Quantité initiale']?.number,
      seuilAlerte: p.properties['Seuil alerte']?.number,
      unite: p.properties['Unité']?.select?.name,
      statut: p.properties['Statut']?.select?.name,
      restaurant: p.properties['Restaurant']?.rich_text?.[0]?.plain_text,
      restaurantId: p.properties['Restaurant ID']?.rich_text?.[0]?.plain_text,
      derniereMaj: p.properties['Dernière mise à jour']?.rich_text?.[0]?.plain_text
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/stocks', async (req, res) => {
  const { produit, quantite, seuilAlerte, unite, restaurant, restaurantId } = req.body;
  try {
    const r = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        parent: { database_id: DB_STOCKS },
        properties: {
          'Produit': { title: [{ text: { content: produit } }] },
          'Quantité actuelle': { number: parseFloat(quantite) || 0 },
          'Quantité initiale': { number: parseFloat(quantite) || 0 },
          'Seuil alerte': { number: parseFloat(seuilAlerte) || 5 },
          'Unité': { select: { name: unite || 'unité' } },
          'Statut': { select: { name: 'Disponible' } },
          'Restaurant': { rich_text: [{ text: { content: restaurant || '' } }] },
          'Restaurant ID': { rich_text: [{ text: { content: restaurantId || '' } }] },
          'Dernière mise à jour': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] }
        }
      })
    });
    const page = await r.json();
    res.json({ success: true, id: page.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/stocks/:id', async (req, res) => {
  const { quantite } = req.body;
  const qty = parseFloat(quantite);
  const statut = qty <= 0 ? 'Rupture' : qty <= (req.body.seuilAlerte || 5) ? 'Alerte' : 'Disponible';
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({
        properties: {
          'Quantité actuelle': { number: qty },
          'Statut': { select: { name: statut } },
          'Dernière mise à jour': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] }
        }
      })
    });
    res.json({ success: true, statut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/stocks/:id', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ archived: true })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/admin/reset-password/:id', async (req, res) => {
  const pwd = generatePassword();
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({
        properties: {
          'Mot de passe': { rich_text: [{ text: { content: hashPassword(pwd) } }] }
        }
      })
    });
    res.json({ success: true, motDePasse: pwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TWILIO + IA ──────────────────────────────────────

app.post('/twilio/appel', async (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="Polly.Lea">
    Bonjour, bienvenue chez ${req.query.restaurant || 'le restaurant'}. 
    Je suis votre assistant de commande. 
    Veuillez dicter votre commande après le bip.
  </Say>
  <Record 
    action="/twilio/traiter?restaurantId=${req.query.restaurantId || ''}&restaurant=${req.query.restaurant || ''}"
    method="POST"
    maxLength="30"
    playBeep="true"
    transcribe="false"
  />
</Response>`;
  res.type('text/xml').send(twiml);
});

app.post('/twilio/traiter', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const restaurantId = req.query.restaurantId;
  const restaurant = req.query.restaurant;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR" voice="Polly.Lea">
    Merci, votre commande est en cours de traitement. Au revoir.
  </Say>
</Response>`;
  res.type('text/xml').send(twiml);

  setTimeout(async () => {
    try {
      const audioRes = await fetch(recordingUrl + '.mp3', {
        headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64') }
      });
      const audioBuffer = await audioRes.arrayBuffer();
      const { result } = await deepgram.listen.prerecorded.transcribeFile(
        Buffer.from(audioBuffer),
        { model: 'nova-2', language: 'fr' }
      );
      const transcription = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      console.log('Transcription:', transcription);

      if (!transcription) return;

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
content: `Tu es un assistant de restaurant. Extrait les informations de cette commande vocale et réponds UNIQUEMENT en JSON valide sans markdown.
Commande vocale: "${transcription}"
Format de réponse:
{
  "name": "prénom du client ou Inconnu",
  "phone": "numéro de téléphone ou vide",
  "sandwich": "nom du sandwich commandé",
  "boisson": "boisson commandée ou Eau",
  "option": "frites ou salade ou rien",
  "modif": "modifications demandées ou vide",
  "allergy": "allergies mentionnées ou vide",
  "surPlace": true ou false (true si le client dit sur place, false si à emporter ou non précisé)
}`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      const jsonText = claudeData.content?.[0]?.text || '{}';
      const commande = JSON.parse(jsonText);

      const cmd = {
        id: nextId++,
        ...commande,
        restaurantId,
        restaurant,
        state: 'new',
        chronoStart: null,
        chronoEnd: null,
        createdAt: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      };
      commandes.push(cmd);
      io.emit('nouvelle_commande', cmd);
      console.log('Commande créée:', cmd);
    } catch (e) {
      console.log('Erreur traitement commande:', e.message);
    }
  }, 3000);
});

// ─── COMMANDE VOCALE VIA CLIENT WEB ──────────────────

app.post('/api/order/voice/session', async (req, res) => {
  try {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId manquant' });

    const restauRes = await fetch(`https://api.notion.com/v1/pages/${restaurantId}`, {
      method: 'GET', headers: notionHeaders
    });
    const restau = await restauRes.json();
    if (restau.object === 'error') return res.status(404).json({ error: 'Restaurant non trouvé' });

    const nomRestaurant = restau.properties['Nom du restaurant']?.title?.[0]?.plain_text || 'Restaurant';

    const menuRes = await fetch(`https://api.notion.com/v1/databases/${DB_MENUS}/query`, {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Restaurant ID', rich_text: { equals: restaurantId } },
            { property: 'Restaurant', rich_text: { equals: nomRestaurant } }
          ]
        }
      })
    });
    const menuData = await menuRes.json();
    const menuItems = (menuData.results || []).map(p => {
      const props = p.properties;
      return {
        nom: props['Nom du produit']?.title?.[0]?.plain_text || '',
        prix: props['Prix']?.number || 0,
        prixMenu: props['Prix menu']?.number || 0,
        dispoMenu: props['Disponible en menu']?.checkbox || false,
        categorie: props['Catégorie']?.select?.name || '',
        ingredients: props['Ingrédients']?.rich_text?.[0]?.plain_text || '',
        ingredientsRetirables: props['Ingrédients retirables']?.rich_text?.[0]?.plain_text || '',
        allergenes: props['Allergènes']?.multi_select?.map(a => a.name) || []
      };
    });

    // ── Charger le stock pour filtrer les produits indisponibles ──
    let stockMap = {}; // { nomProduitLower: { qty, statut } }
    let stockVide = false;
    try {
      const stockRes = await fetch(`https://api.notion.com/v1/databases/${DB_STOCKS}/query`, {
        method: 'POST', headers: notionHeaders,
        body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: restaurantId } } })
      });
      const stockData = await stockRes.json();
      if (stockData.results && stockData.results.length > 0) {
        for (const s of stockData.results) {
          const nom = s.properties['Produit']?.title?.[0]?.plain_text || '';
          const qty = s.properties['Quantité actuelle']?.number ?? 0;
          const statut = s.properties['Statut']?.select?.name || 'Disponible';
          if (nom) stockMap[nom.toLowerCase()] = { qty, statut };
        }
      } else {
        // Aucun stock configuré → on considère tout comme disponible (pas de blocage)
        stockVide = true;
      }
    } catch (e) { console.log('Erreur chargement stock session:', e.message); stockVide = true; }

    // Marquer chaque article du menu selon disponibilité stock
    // On vérifie d'abord le produit lui-même, puis ses INGRÉDIENTS (pour détecter les ruptures indirectes)
    const menuAvecDispo = menuItems.map(item => {
      if (stockVide) return { ...item, dispo: true, stockQty: null };
      const key = item.nom.toLowerCase().trim();

      // 1. Chercher le produit fini directement dans le stock (cas rare)
      const stockEntryDirect = stockMap[key];
      if (stockEntryDirect) {
        const dispo = stockEntryDirect.statut !== 'Rupture' && stockEntryDirect.qty > 0;
        return { ...item, dispo, stockQty: stockEntryDirect.qty };
      }

      // 2. Vérifier chaque ingrédient du produit dans le stock (avec quantités)
      const ings = parseIngredientsWithQty(item.ingredients);
      const ingEnRupture = [];
      let minStock = null;
      for (const ing of ings) {
        const ingKey = ing.nom.toLowerCase().trim();
        const ingStock = stockMap[ingKey];
        if (ingStock) {
          if (ingStock.statut === 'Rupture' || ingStock.qty <= 0) {
            ingEnRupture.push(`${ing.qty > 1 ? ing.qty + 'x ' : ''}${ing.nom}`);
          }
          // Stock effectif = qty disponible / qty recette (combien de portions restantes)
          const portionsRestantes = ing.qty > 1 ? Math.floor(ingStock.qty / ing.qty) : ingStock.qty;
          if (minStock === null || portionsRestantes < minStock) minStock = portionsRestantes;
        }
      }

      if (ingEnRupture.length > 0) {
        return { ...item, dispo: false, stockQty: 0, ingEnRupture,
          raisonRupture: ingEnRupture.join(', ') + ' épuisé(s)' };
      }

      // 3. Aucun ingrédient en rupture → disponible
      return { ...item, dispo: true, stockQty: minStock };
    });

    const sid = Date.now().toString();

    // Stocker la session avec le menu et le stock
    voiceSessions[sid] = { panier: [], historique: [], menu: menuAvecDispo, restaurant: nomRestaurant, restaurantId, stockVide };

    res.json({
      success: true,
      sessionId: sid,
      restaurantData: {
        nom: nomRestaurant,
        menu: menuAvecDispo
      },
      greeting: `Bonjour ! Bienvenue chez ${nomRestaurant}. Que souhaitez-vous commander ?`
    });
  } catch (e) {
    console.log('Erreur session vocale:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/order/voice/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) return res.status(400).json({ error: 'sessionId et message requis' });

    if (!voiceSessions[sessionId]) {
      return res.status(400).json({ error: 'Session expirée, rechargez la page' });
    }
    const session = voiceSessions[sessionId];
    session.historique.push({ role: 'user', content: message });

    // Séparer produits disponibles et épuisés
    const menuDispo    = session.menu.filter(p => p.dispo !== false);
    const menuRupture  = session.menu.filter(p => p.dispo === false);

    const menuTexte = menuDispo.map(p =>
      `- ${p.nom} (${p.categorie}) : ${p.prix}€${p.dispoMenu ? ' | En menu : ' + p.prixMenu + '€' : ''}${p.ingredients ? ' | Ingrédients : ' + p.ingredients : ''}${p.ingredientsRetirables ? ' | Retirables : ' + p.ingredientsRetirables : ''}${p.stockQty !== null && p.stockQty !== undefined ? ' | Stock : ' + p.stockQty + ' restants' : ''}`
    ).join('\n');

    const ruptureTexte = menuRupture.length
      ? '\n\nPRODUITS ÉPUISÉS (à ne JAMAIS proposer ni accepter — ingrédient manquant) :\n' +
        menuRupture.map(p => `- ${p.nom}${p.raisonRupture ? ' [' + p.raisonRupture + ']' : ''}`).join('\n')
      : '';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: `Tu es un assistant de prise de commande pour le restaurant "${session.restaurant}".

CARTE DU RESTAURANT (produits disponibles uniquement) :
${menuTexte}${ruptureTexte}

PANIER ACTUEL : ${JSON.stringify(session.panier)}
SUR PLACE ACTUEL : ${session.surPlace === true ? 'sur place' : session.surPlace === false ? 'à emporter' : 'non précisé'}

RÈGLES :
- Utilise UNIQUEMENT les produits listés dans la carte ci-dessus
- Si un produit est dans la liste PRODUITS ÉPUISÉS, dis poliment qu'il n'est plus disponible aujourd'hui et propose une alternative disponible
- Si le client demande un produit qui n'existe pas dans la carte, dis-lui poliment et propose des alternatives
- Si le client demande "en menu" et que le produit est disponible en menu, utilise le prix menu
- Note les modifications (sans cornichon, sans oignon, etc.) dans le champ modifications
- Si le client dit "c'est tout", "valider", "confirmer", mets commandePrete à true
- Sois naturel et sympa, comme un vrai employé de fast-food
- Si le client n'a pas encore précisé sur place ou à emporter, demande-lui avant de finaliser la commande
- Détecte si le client dit "sur place", "ici", "en salle" → surPlace: true ; "à emporter", "emporter", "pour partir" → surPlace: false
- Si le client demande plusieurs burger et qu'il veut un menu, proposer pour tous les burgers, si oui mettre le nombre de firte et boisson en adequatioin, si non mettre le nombre de frite et de coca par rapport au nombre de menu
demandé
- Si des ingrédients en rupture indiqué directement que les burgers choisis sont en rupture et donc non disponible 

Réponds UNIQUEMENT en JSON valide (pas de markdown, pas de backticks).
Format :
{
  "response": "ta réponse au client",
  "panier": [{"nom": "nom exact du produit", "quantite": 1, "prix": 0.00, "modifications": "ingrédients retirés ou ajouts (ex: sans cornichon, sans glaçons) — vide si aucune modif", "categorie": "Sandwich|Boisson|Accompagnement|Dessert|Menu"}],
  "totalPrice": 0.00,
  "commandePrete": false,
  "surPlace": null
}
Note : surPlace doit être true (sur place), false (à emporter), ou null (non encore précisé).
Note : le champ "categorie" doit correspondre à la catégorie du produit dans la carte. "modifications" ne doit contenir QUE les ingrédients retirés/ajoutés, pas les options de menu (frites, coca inclus dans le menu ne sont pas des modifications).`,
        messages: session.historique
      })
    });

    const claudeData = await claudeRes.json();
    console.log('Réponse Claude brute:', JSON.stringify(claudeData).slice(0, 500));
    let jsonText = claudeData.content?.[0]?.text || '{}';
    
    // Nettoyer les backticks markdown si Claude en ajoute
    jsonText = jsonText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.log('Erreur parsing JSON Claude:', jsonText);
      parsed = { response: jsonText, panier: session.panier, totalPrice: 0, commandePrete: false };
    }

    session.panier = parsed.panier || [];
    session.historique.push({ role: 'assistant', content: parsed.response });
    // Mettre à jour surPlace si Claude l'a détecté
    if (parsed.surPlace === true || parsed.surPlace === false) {
      session.surPlace = parsed.surPlace;
    }

    res.json({
      response: parsed.response,
      panier: session.panier,
      totalPrice: parsed.totalPrice || 0,
      commandePrete: parsed.commandePrete || false,
      surPlace: session.surPlace ?? null
    });
  } catch (e) {
    console.log('Erreur message vocal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/order/voice/confirm', async (req, res) => {
  try {
    const { sessionId, clientName, clientPhone } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requis' });

    const session = voiceSessions[sessionId];
    if (!session || !session.panier.length) return res.status(400).json({ error: 'Panier vide' });

    // ── Catégoriser les articles du panier ──────────────────
    const CAT_SANDWICH    = ['Sandwich', 'Menu', 'Burger', 'Plat'];
    const CAT_BOISSON     = ['Boisson', 'Boissons', 'Drink'];
    const CAT_ACCOMP      = ['Accompagnement', 'Accompagnements', 'Frites', 'Salade'];
    const CAT_DESSERT     = ['Dessert', 'Desserts', 'Glace'];

    // Fallback : si categorie manquante, on tente de la deviner via le menu stocké en session
    const menuRef = session.menu || [];
    function getCategorie(item) {
      if (item.categorie) return item.categorie;
      const found = menuRef.find(m => m.nom && m.nom.toLowerCase() === (item.nom || '').toLowerCase());
      return found ? found.categorie : '';
    }

    const sandwichItems = session.panier.filter(p => CAT_SANDWICH.includes(getCategorie(p)));
    const boissonItems  = session.panier.filter(p => CAT_BOISSON.includes(getCategorie(p)));
    const accompItems   = session.panier.filter(p => CAT_ACCOMP.includes(getCategorie(p)));
    const dessertItems  = session.panier.filter(p => CAT_DESSERT.includes(getCategorie(p)));
    // Articles non catégorisés → on les met dans sandwich par défaut
    const autresItems   = session.panier.filter(p => {
      const cat = getCategorie(p);
      return !CAT_SANDWICH.includes(cat) && !CAT_BOISSON.includes(cat) && !CAT_ACCOMP.includes(cat) && !CAT_DESSERT.includes(cat);
    });

    function formatItem(p) {
      return p.quantite > 1 ? `${p.quantite}x ${p.nom}` : p.nom;
    }

    const sandwichStr = [...sandwichItems, ...autresItems].map(formatItem).join(', ') || '—';
    const boissonStr  = boissonItems.map(formatItem).join(', ') || '';
    const accompStr   = accompItems.map(formatItem).join(', ') || '';
    const dessertStr  = dessertItems.map(formatItem).join(', ') || '';
    // Compat : on garde option pour les vieilles commandes sans catégorie
    const optionStr   = accompStr || dessertStr ? '' : [...accompItems, ...dessertItems].map(formatItem).join(', ');

    // Modifications : uniquement les vrais ingrédients retirés/ajoutés
    const modifStr = session.panier
      .filter(p => p.modifications && p.modifications.trim())
      .map(p => `${p.nom} : ${p.modifications}`)
      .join(' | ') || '';

    const cmd = {
      id: nextId++,
      name: clientName || 'Client vocal',
      phone: clientPhone || '',
      sandwich: sandwichStr,
      boisson: boissonStr,
      option: optionStr,
      accompagnement: accompStr,
      dessert: dessertStr,
      modif: modifStr,
      allergy: '',
      surPlace: session.surPlace === true,
      restaurantId: session.restaurantId || '',
      restaurant: session.restaurant || '',
      // Panier brut : permet une déduction de stock précise (modifications par article)
      panierRaw: session.panier,
      state: 'new',
      chronoStart: null,
      chronoEnd: null,
      createdAt: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };

    commandes.push(cmd);
    io.emit('nouvelle_commande', cmd);

    delete voiceSessions[sessionId];

    res.json({ success: true, commande: cmd });
  } catch (e) {
    console.log('Erreur confirmation:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ANALYTICS AGRÉGÉS ───────────────────────────────
app.get('/analytics', (req, res) => {
  const { restaurantId, days: daysStr } = req.query;
  if (!restaurantId) return res.status(400).json({ error: 'restaurantId requis' });
  const days = Math.min(parseInt(daysStr || '14') || 14, 90);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

  const allArchives = getMemoryArchives(restaurantId);
  const doneOrders = allArchives.filter(c => c.state === 'done' && (c.archivedDate || todayStr()) >= startDate);
  const refusedOrders = allArchives.filter(c => c.state === 'refused' && (c.archivedDate || todayStr()) >= startDate);

  const salesByProduct = {}, revenueByProduct = {};
  const revenueByCategory = { Sandwich: 0, Boisson: 0, Accompagnement: 0, Dessert: 0, Autre: 0 };
  const revenueByDay = {}, ordersByDay = {}, surPlaceByDay = {};
  let totalRevenue = 0;

  // Pré-remplir tous les jours de la période
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().split('T')[0];
    revenueByDay[d] = 0; ordersByDay[d] = 0; surPlaceByDay[d] = 0;
  }

  doneOrders.forEach(cmd => {
    const date = cmd.archivedDate || todayStr();
    ordersByDay[date] = (ordersByDay[date] || 0) + 1;
    if (cmd.surPlace) surPlaceByDay[date] = (surPlaceByDay[date] || 0) + 1;

    const items = Array.isArray(cmd.panierRaw) ? cmd.panierRaw : [];
    items.forEach(item => {
      const nom = item.nom || '';
      const qty = item.quantite || 1;
      const prix = (item.prix || 0) * qty;
      const cat = item.categorie || 'Autre';
      salesByProduct[nom] = (salesByProduct[nom] || 0) + qty;
      revenueByProduct[nom] = (revenueByProduct[nom] || 0) + prix;
      const catKey = ['Sandwich', 'Boisson', 'Accompagnement', 'Dessert'].includes(cat) ? cat : 'Autre';
      revenueByCategory[catKey] += prix;
      revenueByDay[date] = (revenueByDay[date] || 0) + prix;
      totalRevenue += prix;
    });
  });

  const topProducts = Object.entries(salesByProduct)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([nom, qty]) => ({ nom, qty, revenue: Math.round((revenueByProduct[nom] || 0) * 100) / 100 }));

  res.json({
    totalOrders: doneOrders.length,
    refusedOrders: refusedOrders.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    avgOrderValue: doneOrders.length ? Math.round(totalRevenue / doneOrders.length * 100) / 100 : 0,
    revenueByDay,
    ordersByDay,
    surPlaceByDay,
    revenueByCategory,
    topProducts,
    salesByProduct,
  });
});

// ─── ADMIN STATS / HEALTH / BROADCAST / MESSAGERIE ──

app.get('/admin/stats', (req, res) => {
  const today = todayStr();
  let totalToday = 0, caToday = 0, totalAllTime = 0, totalRefused = 0;
  const activityByHour = Array(24).fill(0);
  const caByRestaurant = {};
  for (const [rid, list] of Object.entries(archivesMemory)) {
    const done = list.filter(c => c.state === 'done');
    const todayDone = done.filter(c => (c.archivedDate || '').startsWith(today));
    totalToday += todayDone.length;
    caToday += todayDone.reduce((s, c) => s + (c.total || 0), 0);
    totalAllTime += done.length;
    totalRefused += list.filter(c => c.state === 'refused').length;
    caByRestaurant[rid] = done.reduce((s, c) => s + (c.total || 0), 0);
    todayDone.forEach(c => {
      const h = c.timestamp ? new Date(c.timestamp).getHours() : new Date().getHours();
      activityByHour[h]++;
    });
  }
  res.json({
    totalToday, caToday: Math.round(caToday * 100) / 100,
    totalAllTime, totalRefused,
    restaurantsWithData: Object.keys(archivesMemory).length,
    activityByHour, caByRestaurant,
    voiceSessions: Object.keys(voiceSessions).length
  });
});

app.get('/admin/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.floor(process.uptime()),
    memory: { rss: Math.round(mem.rss / 1024 / 1024), heapUsed: Math.round(mem.heapUsed / 1024 / 1024), heapTotal: Math.round(mem.heapTotal / 1024 / 1024) },
    voiceSessions: Object.keys(voiceSessions).length,
    totalArchives: Object.values(archivesMemory).reduce((s, a) => s + a.length, 0),
    timestamp: new Date().toISOString(),
    nodeVersion: process.version
  });
});

// ─── BROADCASTS (persistants fichier) ────────────────
app.get('/admin/broadcast', (req, res) => {
  const bs = loadBroadcasts();
  const { restaurantId } = req.query;
  if (restaurantId) {
    // Pour un restaurant: exclure ceux qu'il a dismissés
    return res.json(bs.filter(b => !(b.dismissedBy||[]).includes(restaurantId)));
  }
  res.json(bs);
});

app.post('/admin/broadcast', (req, res) => {
  const { message, type, author } = req.body;
  if (!message) return res.status(400).json({ error: 'Message requis' });
  const b = { id: Date.now().toString(), message, type: type || 'info', author: author || 'Admin', createdAt: new Date().toISOString(), dismissedBy: [] };
  const bs = loadBroadcasts();
  bs.unshift(b);
  if (bs.length > 200) bs.splice(200);
  saveBroadcasts(bs);
  io.emit('broadcast', b);
  res.json({ success: true, broadcast: b });
});

app.delete('/admin/broadcast/:id', (req, res) => {
  const bs = loadBroadcasts();
  const idx = bs.findIndex(b => b.id === req.params.id);
  if (idx !== -1) bs.splice(idx, 1);
  saveBroadcasts(bs);
  res.json({ success: true });
});

// Dismiss d'un broadcast (côté restaurant)
app.patch('/admin/broadcast/:id/dismiss', (req, res) => {
  const { restaurantId } = req.body;
  const bs = loadBroadcasts();
  const b = bs.find(b => b.id === req.params.id);
  if (b && restaurantId && !(b.dismissedBy||[]).includes(restaurantId)) {
    b.dismissedBy = b.dismissedBy || [];
    b.dismissedBy.push(restaurantId);
    saveBroadcasts(bs);
  }
  res.json({ success: true });
});

// ─── MESSAGERIE ──────────────────────────────────────
// GET messages d'un restaurant
app.get('/messages/:restaurantId', (req, res) => {
  res.json(loadMessages(req.params.restaurantId));
});

// POST envoyer un message (admin → restaurant ou restaurant → admin)
app.post('/messages/:restaurantId', (req, res) => {
  const { from, fromName, content, type, meta } = req.body;
  if (!content) return res.status(400).json({ error: 'Contenu requis' });
  const msgs = loadMessages(req.params.restaurantId);
  const msg = {
    id: Date.now().toString(),
    restaurantId: req.params.restaurantId,
    from: from || 'admin',      // 'admin' | 'restaurant'
    fromName: fromName || 'Admin',
    content,
    type: type || 'message',    // 'message' | 'restock_alert' | 'system'
    meta: meta || null,
    timestamp: new Date().toISOString(),
    readBy: [],
    dismissed: false
  };
  msgs.push(msg);
  if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
  saveMessages(req.params.restaurantId, msgs);
  // Notif temps réel
  io.emit(`msg_${req.params.restaurantId}`, msg);
  io.emit('admin_new_msg', { restaurantId: req.params.restaurantId, msg });
  res.json({ success: true, msg });
});

// PATCH marquer comme lu
app.patch('/messages/:restaurantId/:msgId/read', (req, res) => {
  const { by } = req.body;
  const msgs = loadMessages(req.params.restaurantId);
  const m = msgs.find(m => m.id === req.params.msgId);
  if (m && by && !m.readBy.includes(by)) m.readBy.push(by);
  saveMessages(req.params.restaurantId, msgs);
  res.json({ success: true });
});

// PATCH marquer tous comme lus
app.patch('/messages/:restaurantId/read-all', (req, res) => {
  const { by } = req.body;
  const msgs = loadMessages(req.params.restaurantId);
  msgs.forEach(m => { if (by && !m.readBy.includes(by)) m.readBy.push(by); });
  saveMessages(req.params.restaurantId, msgs);
  res.json({ success: true });
});

// DELETE supprimer un message
app.delete('/messages/:restaurantId/:msgId', (req, res) => {
  let msgs = loadMessages(req.params.restaurantId);
  msgs = msgs.filter(m => m.id !== req.params.msgId);
  saveMessages(req.params.restaurantId, msgs);
  res.json({ success: true });
});

// GET liste des conversations pour admin (résumé par restaurant)
app.get('/admin/conversations', async (req, res) => {
  try {
    const files = fs.readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'));
    const convos = [];
    for (const f of files) {
      const rid = f.replace('messages_', '').replace('.json', '');
      const msgs = loadMessages(rid);
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter(m => m.from === 'restaurant' && !m.readBy.includes('admin')).length;
      convos.push({ restaurantId: rid, lastMessage: last, unread, total: msgs.length });
    }
    convos.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    res.json(convos);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── RESTOCK RECOMMENDATIONS ─────────────────────────
app.get('/restock-recommendations/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  const { days = 14 } = req.query;
  try {
    // Charger le stock actuel
    const stockRes = await fetch(`https://api.notion.com/v1/databases/${process.env.DB_STOCKS || ''}/query`, {
      method: 'POST', headers: notionHeaders,
      body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: restaurantId } } })
    });
    let stockItems = [];
    if (stockRes.ok) {
      const stockData = await stockRes.json();
      stockItems = (stockData.results || []).map(p => ({
        id: p.id,
        nom: p.properties['Nom']?.title?.[0]?.plain_text || '',
        quantite: p.properties['Quantité actuelle']?.number ?? 0,
        unite: p.properties['Unité']?.select?.name || '',
        seuilAlerte: p.properties['Seuil d\'alerte']?.number ?? 5,
        statut: p.properties['Statut']?.select?.name || 'OK'
      }));
    }

    // Analyser la consommation sur les N derniers jours
    const cutoff = new Date(Date.now() - parseInt(days) * 86400000).toISOString().split('T')[0];
    const archives = getMemoryArchives(restaurantId);
    const recentOrders = archives.filter(c => c.state === 'done' && (c.archivedDate || '') >= cutoff);

    // Compter la consommation par ingrédient
    const consumptionMap = {};
    recentOrders.forEach(cmd => {
      const items = cmd.panierRaw || [];
      items.forEach(item => {
        const key = (item.nom || '').toLowerCase().trim();
        const menuKey = Object.keys(menuMap).find(k => key.includes(k) || k.includes(key));
        if (menuKey) {
          const ings = menuMap[menuKey] || [];
          const qte = item.quantite || 1;
          ings.forEach(ing => {
            const ingKey = (ing.nom || ing).toLowerCase().trim();
            const ingQty = (ing.qty || 1) * qte;
            consumptionMap[ingKey] = (consumptionMap[ingKey] || 0) + ingQty;
          });
        }
      });
    });

    // Générer les recommandations
    const daysNum = parseInt(days);
    const recommendations = [];
    stockItems.forEach(item => {
      const key = item.nom.toLowerCase().trim();
      const totalConsumed = consumptionMap[key] || 0;
      const avgPerDay = totalConsumed / daysNum;
      const daysRemaining = avgPerDay > 0 ? Math.floor(item.quantite / avgPerDay) : null;
      const weeklyNeed = Math.ceil(avgPerDay * 7);
      const urgency = daysRemaining !== null
        ? daysRemaining <= 1 ? 'critique' : daysRemaining <= 3 ? 'urgent' : daysRemaining <= 7 ? 'attention' : null
        : item.statut === 'Rupture' ? 'critique' : null;

      if (urgency || item.statut === 'Rupture' || item.statut === 'Alerte') {
        recommendations.push({
          id: item.id,
          nom: item.nom,
          quantiteActuelle: item.quantite,
          unite: item.unite,
          statut: item.statut,
          totalConsumed: Math.round(totalConsumed * 10) / 10,
          avgPerDay: Math.round(avgPerDay * 10) / 10,
          daysRemaining,
          weeklyNeed,
          urgency: urgency || 'attention',
          seuilAlerte: item.seuilAlerte
        });
      }
    });

    recommendations.sort((a, b) => {
      const order = { critique: 0, urgent: 1, attention: 2 };
      return (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3);
    });

    res.json({ recommendations, period: daysNum, totalOrders: recentOrders.length });
  } catch(e) {
    console.error('Restock error:', e);
    res.json({ recommendations: [], period: parseInt(days), totalOrders: 0 });
  }
});

// Envoyer une alerte restock comme message
app.post('/admin/restock-alert/:restaurantId', async (req, res) => {
  const { restaurantId } = req.params;
  const { items, author } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items requis' });
  const content = `⚠️ Alerte réapprovisionnement : ${items.map(i => `${i.nom} (${i.quantiteActuelle} ${i.unite} restants, besoin estimé: ${i.weeklyNeed}/semaine)`).join(' · ')}`;
  const msgs = loadMessages(restaurantId);
  const msg = {
    id: Date.now().toString(), restaurantId,
    from: 'admin', fromName: author || 'Système',
    content, type: 'restock_alert',
    meta: { items },
    timestamp: new Date().toISOString(), readBy: [], dismissed: false
  };
  msgs.push(msg);
  saveMessages(restaurantId, msgs);
  io.emit(`msg_${restaurantId}`, msg);
  io.emit('admin_new_msg', { restaurantId, msg });
  res.json({ success: true, msg });
});

// ─── PING & START ────────────────────────────────────

app.get('/ping', (req, res) => res.json({ message: 'Serveur en ligne ✅' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));
