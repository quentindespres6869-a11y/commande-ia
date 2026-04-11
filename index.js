const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();
const twilio = require('twilio');
const { createClient } = require('@deepgram/sdk');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_RESTAURANTS = '2954180a10da476da3f20db69bd7bdbf';
const DB_EMPLOYES = '26a7bfc0e3b147aeae55e87dffeee763';
const ADMIN_EMAIL = 'quentin@commande-ia.fr'; // ← ton email admin
const DB_MENUS = 'aa3d9c7174e641f2a82265a8fca8d251';
const DB_STOCKS = '2bab39532bb24fe3b874a7eb92415f8e';

const notionHeaders = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28'
};

let commandes = [], archives = [], nextId = 1;

function hashPassword(pwd) { return crypto.createHash('sha256').update(pwd).digest('hex'); }
function generatePassword() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

// ─── COMMANDES ───────────────────────────────────────

app.get('/commandes', (req, res) => res.json(commandes));
app.get('/archives', (req, res) => res.json(archives));

app.post('/commandes', (req, res) => {
  const cmd = { id: nextId++, ...req.body, state: 'new', chronoStart: null, chronoEnd: null, createdAt: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) };
  commandes.push(cmd); io.emit('nouvelle_commande', cmd); res.json(cmd);
});

app.patch('/commandes/:id/valider', async (req, res) => {
  const cmd = commandes.find(c => c.id === parseInt(req.params.id));
  if (!cmd) return res.status(404).json({ error: 'Introuvable' });
  cmd.state = 'validated'; cmd.chronoStart = Date.now();
  io.emit('commande_mise_a_jour', cmd);

  // Déduire le stock automatiquement si restaurantId disponible
  if (cmd.restaurantId) {
    try {
      const r = await fetch(`https://api.notion.com/v1/databases/${DB_STOCKS}/query`, {
        method: 'POST', headers: notionHeaders,
        body: JSON.stringify({ filter: { property: 'Restaurant ID', rich_text: { equals: cmd.restaurantId } } })
      });
      const data = await r.json();
      if (data.results) {
        for (const stock of data.results) {
          const nomProduit = stock.properties['Produit']?.title?.[0]?.plain_text?.toLowerCase();
          const sandwich = (cmd.sandwich || '').toLowerCase();
          const boisson = (cmd.boisson || '').toLowerCase();
          if (nomProduit && (sandwich.includes(nomProduit) || boisson.includes(nomProduit) || nomProduit.includes(sandwich) || nomProduit.includes(boisson))) {
            const qtyActuelle = stock.properties['Quantité actuelle']?.number || 0;
            const seuilAlerte = stock.properties['Seuil alerte']?.number || 5;
            const newQty = Math.max(0, qtyActuelle - 1);
            const statut = newQty <= 0 ? 'Rupture' : newQty <= seuilAlerte ? 'Alerte' : 'Disponible';
            await fetch(`https://api.notion.com/v1/pages/${stock.id}`, {
              method: 'PATCH', headers: notionHeaders,
              body: JSON.stringify({
                properties: {
                  'Quantité actuelle': { number: newQty },
                  'Statut': { select: { name: statut } },
                  'Dernière mise à jour': { rich_text: [{ text: { content: new Date().toLocaleString('fr-FR') } }] }
                }
              })
            });
          }
        }
      }
    } catch (e) { console.log('Erreur déduction stock:', e.message); }
  }

  res.json(cmd);
});

app.patch('/commandes/:id/prete', (req, res) => {
  const idx = commandes.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  const cmd = commandes[idx];
  cmd.state = 'done'; cmd.chronoEnd = Date.now();
  cmd.archivedAt = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  archives.unshift(cmd); commandes.splice(idx, 1);
  io.emit('commande_terminee', cmd); res.json(cmd);
});

app.patch('/commandes/:id/refuser', (req, res) => {
  const idx = commandes.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Introuvable' });
  const cmd = commandes[idx];
  cmd.state = 'refused';
  cmd.archivedAt = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  archives.unshift(cmd); commandes.splice(idx, 1);
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
      adresse: props['Adresse']?.rich_text?.[0]?.plain_text
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
    res.json({ success: true, id: page.id });
  } catch (e) { res.status(500).json({ error: 'Erreur création produit' }); }
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
// Supprimer un restaurant
app.delete('/admin/restaurants/:id', async (req, res) => {
  try {
    await fetch(`https://api.notion.com/v1/pages/${req.params.id}`, {
      method: 'PATCH', headers: notionHeaders,
      body: JSON.stringify({ archived: true })
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// Supprimer un employé
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

  // Traitement en arrière-plan
  setTimeout(async () => {
    try {
      // 1. Transcrire avec Deepgram
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

      // 2. Structurer avec Claude
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
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
  "allergy": "allergies mentionnées ou vide"
}`
          }]
        })
      });
      const claudeData = await claudeRes.json();
      const jsonText = claudeData.content?.[0]?.text || '{}';
      const commande = JSON.parse(jsonText);

      // 3. Envoyer au dashboard
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


app.get('/ping', (req, res) => res.json({ message: 'Serveur en ligne ✅' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));