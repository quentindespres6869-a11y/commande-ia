/**
 * Support Overlay — Commande-IA
 * Widget flottant de tickets support à injecter dans n'importe quelle page restaurant.
 * Usage: <script src="/support-overlay.js"></script>
 * Requiert: currentUser en sessionStorage, socket.io chargé
 */
(function() {
  'use strict';

  const TYPES = { bug:'🐛 Bug', question:'❓ Question', feature:'✨ Fonctionnalité', urgent:'🚨 Urgent' };
  const PRIORITES = { critique:'🔴 Critique', haute:'🟠 Haute', normale:'🟡 Normale', basse:'🟢 Basse' };
  const STATUTS = {
    ouvert:     { label:'Ouvert',      color:'#2a50aa', bg:'#eff4ff' },
    en_cours:   { label:'En cours',    color:'#906010', bg:'#fff8ec' },
    en_attente: { label:'En attente',  color:'#555',    bg:'#f5f5f5' },
    resolu:     { label:'Résolu',      color:'#2d6a0a', bg:'#f0f7e8' },
    ferme:      { label:'Fermé',       color:'#888',    bg:'#f5f5f5' }
  };
  const PROGRESS_LABELS = { ouvert:10, en_cours:50, en_attente:70, resolu:100, ferme:100 };

  function timeAgo(iso) {
    const d = Date.now() - new Date(iso);
    if (d < 60000) return 'À l\'instant';
    if (d < 3600000) return Math.floor(d/60000) + ' min';
    if (d < 86400000) return Math.floor(d/3600000) + 'h';
    return new Date(iso).toLocaleDateString('fr-FR',{day:'2-digit',month:'short'});
  }
  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  }
  function slaInfo(ticket) {
    if (ticket.statut === 'resolu' || ticket.statut === 'ferme') return null;
    const elapsed = (Date.now() - new Date(ticket.createdAt)) / 3600000;
    const target = ticket.slaTarget || 24;
    const remaining = target - elapsed;
    const pct = Math.min(100, Math.round(elapsed / target * 100));
    return { remaining: Math.max(0, remaining), pct, breached: remaining <= 0, target };
  }

  // ── STYLES ──────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #support-fab {
      position: fixed; bottom: 28px; right: 28px; z-index: 8000;
      width: 54px; height: 54px; border-radius: 16px;
      background: linear-gradient(135deg,#1a3a1a,#2d6a0a);
      border: none; cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 24px rgba(26,58,26,0.35); transition: all 0.2s;
      font-family: 'DM Sans','Inter',system-ui,sans-serif;
    }
    #support-fab:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 10px 32px rgba(26,58,26,0.45); }
    #support-fab-badge {
      position: absolute; top: -5px; right: -5px; background: #e05555; color: #fff;
      font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 10px;
      border: 2px solid #fff; display: none; font-family: 'Inter',sans-serif;
    }
    #support-fab-badge.show { display: block; }

    #support-overlay {
      position: fixed; inset: 0; z-index: 8001;
      display: none; align-items: stretch;
      pointer-events: none;
    }
    #support-overlay.open { display: flex; }
    #support-backdrop {
      position: absolute; inset: 0; background: rgba(0,0,0,0.3);
      backdrop-filter: blur(2px); pointer-events: all;
      animation: soFadeIn 0.2s ease;
    }
    @keyframes soFadeIn { from{opacity:0} to{opacity:1} }

    #support-panel {
      position: absolute; right: 0; top: 0; bottom: 0;
      width: 560px; max-width: 100vw;
      background: #fff; display: flex; flex-direction: column;
      box-shadow: -8px 0 48px rgba(0,0,0,0.15);
      pointer-events: all;
      animation: soSlideIn 0.28s cubic-bezier(0.22,1,0.36,1);
      font-family: 'DM Sans','Inter',system-ui,sans-serif;
    }
    @keyframes soSlideIn { from{transform:translateX(100%)} to{transform:translateX(0)} }

    /* Head */
    .so-head {
      background: #1a3a1a; padding: 18px 20px; display: flex; align-items: center;
      justify-content: space-between; flex-shrink: 0;
    }
    .so-head-left { display: flex; align-items: center; gap: 12px; }
    .so-logo { width: 32px; height: 32px; border-radius: 9px; background: rgba(168,224,122,0.2); display: flex; align-items: center; justify-content: center; font-size: 16px; }
    .so-head-title { font-size: 15px; font-weight: 700; color: #fff; }
    .so-head-sub { font-size: 11px; color: rgba(168,224,122,0.7); margin-top: 1px; }
    .so-close { background: rgba(255,255,255,0.1); border: none; color: #fff; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
    .so-close:hover { background: rgba(255,255,255,0.2); }

    /* Tabs */
    .so-tabs { display: flex; background: #f8fdf4; border-bottom: 1.5px solid #e8f0e0; flex-shrink: 0; }
    .so-tab { flex: 1; padding: 12px 8px; text-align: center; font-size: 12px; font-weight: 600; color: #9ab89a; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 5px; }
    .so-tab:hover { color: #1a3a1a; background: #f0f7e8; }
    .so-tab.active { color: #1a3a1a; border-bottom-color: #4a8a1a; background: #fff; }
    .so-tab-badge { background: #e05555; color: #fff; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 8px; }

    /* Body */
    .so-body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
    .so-view { display: none; flex-direction: column; flex: 1; }
    .so-view.active { display: flex; }

    /* Nouveau ticket */
    .so-form { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
    .so-field { display: flex; flex-direction: column; gap: 5px; }
    .so-label { font-size: 11px; font-weight: 700; color: #5a8a5a; text-transform: uppercase; letter-spacing: 0.7px; }
    .so-input { padding: 10px 12px; border: 1.5px solid #e0ecd8; border-radius: 9px; font-size: 13px; font-family: inherit; background: #f8fdf4; color: #1a2a1a; outline: none; transition: border 0.15s; }
    .so-input:focus { border-color: #4a8a1a; background: #fff; }
    .so-textarea { resize: vertical; min-height: 90px; }
    .so-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .so-select { appearance: none; cursor: pointer; }
    .so-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .so-chip { padding: 6px 12px; border-radius: 20px; border: 1.5px solid #e0ecd8; background: #f8fdf4; font-size: 11px; font-weight: 600; color: #5a8a5a; cursor: pointer; transition: all 0.12s; white-space: nowrap; }
    .so-chip:hover { border-color: #9ad870; }
    .so-chip.sel-bug { background: #fef0f0; border-color: #f5c5c5; color: #b03030; }
    .so-chip.sel-question { background: #eff4ff; border-color: #c5d5f8; color: #2a50aa; }
    .so-chip.sel-feature { background: #f5eeff; border-color: #d5b5f8; color: #7030c0; }
    .so-chip.sel-urgent { background: #fff8ec; border-color: #f0d898; color: #906010; }
    .so-chip.sel-critique { background: #fef0f0; border-color: #e05555; color: #e05555; }
    .so-chip.sel-haute { background: #fff8ec; border-color: #e08a10; color: #e08a10; }
    .so-chip.sel-normale { background: #fffcec; border-color: #c0a010; color: #807010; }
    .so-chip.sel-basse { background: #f0f7e8; border-color: #5ab52a; color: #2d6a0a; }
    .so-meta-toggle { font-size: 11px; color: #9ab89a; cursor: pointer; text-decoration: underline; }
    .so-meta { background: #f8fdf4; border: 1px solid #e0ecd8; border-radius: 8px; padding: 10px 12px; font-size: 11px; color: #5a7a5a; line-height: 1.7; }
    .so-submit { background: #1a3a1a; color: #a8e07a; border: none; border-radius: 10px; padding: 13px; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 7px; }
    .so-submit:hover { background: #2a5a2a; }
    .so-submit:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Mes tickets */
    .so-list { padding: 0; flex: 1; overflow-y: auto; }
    .so-filters { padding: 12px 16px; background: #f8fdf4; border-bottom: 1px solid #e8f0e0; display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
    .so-filter-pill { padding: 4px 10px; border-radius: 14px; border: 1px solid #e0ecd8; background: #fff; font-size: 11px; font-weight: 600; color: #9ab89a; cursor: pointer; transition: all 0.12s; }
    .so-filter-pill.active { background: #1a3a1a; color: #a8e07a; border-color: #1a3a1a; }
    .so-ticket-item { padding: 14px 18px; border-bottom: 1px solid #f0f5ee; cursor: pointer; transition: background 0.1s; display: flex; flex-direction: column; gap: 6px; }
    .so-ticket-item:hover { background: #f8fdf4; }
    .so-ticket-item.active { background: #f0f7e8; border-left: 3px solid #4a8a1a; padding-left: 15px; }
    .so-ticket-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .so-ticket-id { font-size: 9px; font-weight: 700; color: #9ab89a; letter-spacing: 0.5px; }
    .so-ticket-title { font-size: 13px; font-weight: 700; color: #1a2a1a; flex: 1; }
    .so-ticket-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
    .so-badge { font-size: 9px; font-weight: 700; padding: 2px 7px; border-radius: 5px; text-transform: uppercase; letter-spacing: 0.4px; }
    .so-ticket-progress { position: relative; height: 3px; background: #e8f0e0; border-radius: 3px; overflow: hidden; }
    .so-ticket-progress-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg,#5ab52a,#3B6D11); transition: width 0.4s; }
    .so-ticket-footer { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #bbb; }
    .so-new-badge { background: #e05555; color: #fff; font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 8px; }
    .so-empty { padding: 40px 20px; text-align: center; }
    .so-empty-icon { font-size: 36px; margin-bottom: 10px; }
    .so-empty-text { font-size: 13px; color: #ccc; line-height: 1.6; }

    /* Détail ticket */
    .so-detail { padding: 0; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .so-detail-head { padding: 16px 20px; border-bottom: 1px solid #e8f0e0; flex-shrink: 0; }
    .so-back { background: none; border: none; font-size: 12px; font-weight: 600; color: #9ab89a; cursor: pointer; font-family: inherit; display: flex; align-items: center; gap: 4px; margin-bottom: 10px; padding: 0; transition: color 0.12s; }
    .so-back:hover { color: #1a3a1a; }
    .so-detail-title { font-size: 16px; font-weight: 800; color: #1a2a1a; letter-spacing: -0.3px; }
    .so-detail-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
    .so-progress-bar { position: relative; height: 6px; background: #e8f0e0; border-radius: 6px; overflow: hidden; margin: 12px 0 4px; }
    .so-progress-fill { height: 100%; border-radius: 6px; background: linear-gradient(90deg,#5ab52a,#3B6D11); transition: width 0.5s; }
    .so-progress-pct { font-size: 10px; font-weight: 700; color: #5a8a5a; text-align: right; }
    .so-sla { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; padding: 6px 10px; border-radius: 7px; margin-top: 6px; }
    .so-sla.ok { background: #f0f7e8; color: #2d6a0a; }
    .so-sla.warn { background: #fff8ec; color: #906010; }
    .so-sla.breach { background: #fef0f0; color: #b03030; }
    .so-detail-body { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
    .so-desc-block { background: #f8fdf4; border: 1.5px solid #e0ecd8; border-radius: 10px; padding: 14px; font-size: 13px; color: #1a2a1a; line-height: 1.65; }
    .so-section-title { font-size: 10px; font-weight: 700; color: #9ab89a; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
    .so-timeline { display: flex; flex-direction: column; gap: 0; }
    .so-comment { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f0f5ee; }
    .so-comment:last-child { border-bottom: none; }
    .so-comment-avatar { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; flex-shrink: 0; }
    .so-comment-avatar.admin { background: #1a3a1a; }
    .so-comment-avatar.restaurant { background: #4a8a1a; }
    .so-comment-bubble { flex: 1; }
    .so-comment-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .so-comment-author { font-size: 12px; font-weight: 700; color: #1a2a1a; }
    .so-comment-time { font-size: 10px; color: #bbb; }
    .so-comment-internal { font-size: 9px; font-weight: 700; color: #906010; background: #fff8ec; padding: 1px 6px; border-radius: 4px; }
    .so-comment-content { font-size: 13px; color: #333; line-height: 1.5; background: #f8fdf4; border: 1px solid #e8f0e0; border-radius: 0 9px 9px 9px; padding: 8px 12px; }
    .so-comment-content.admin { background: #f0f5ea; border-color: #d8ecc0; }
    .so-reply-area { margin-top: 4px; }
    .so-reply-wrap { display: flex; gap: 8px; align-items: flex-end; }
    .so-reply-input { flex: 1; border: 1.5px solid #e0ecd8; border-radius: 10px; padding: 9px 12px; font-size: 12px; font-family: inherit; background: #f8fdf4; outline: none; resize: none; min-height: 40px; max-height: 100px; transition: border 0.15s; }
    .so-reply-input:focus { border-color: #4a8a1a; background: #fff; }
    .so-reply-btn { width: 38px; height: 38px; border-radius: 9px; background: #1a3a1a; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s; flex-shrink: 0; }
    .so-reply-btn:hover { background: #2a5a2a; }
    .so-rating { display: flex; gap: 6px; }
    .so-star { font-size: 22px; cursor: pointer; opacity: 0.4; transition: opacity 0.15s; }
    .so-star.active { opacity: 1; }
    .so-meta-info { background: #f8fdf4; border: 1px solid #e0ecd8; border-radius: 9px; padding: 12px; font-size: 11px; color: #5a7a5a; }
    .so-meta-row { display: flex; gap: 8px; padding: 2px 0; }
    .so-meta-key { color: #9ab89a; font-weight: 600; min-width: 80px; }

    /* Scrollbar */
    #support-panel ::-webkit-scrollbar { width: 3px; }
    #support-panel ::-webkit-scrollbar-track { background: transparent; }
    #support-panel ::-webkit-scrollbar-thumb { background: #d8e8d0; border-radius: 3px; }

    /* Toast interne */
    .so-toast {
      position: fixed; bottom: 92px; right: 28px; z-index: 8002;
      background: #1a3a1a; color: #a8e07a; padding: 12px 18px;
      border-radius: 12px; font-size: 13px; font-weight: 600; font-family: inherit;
      box-shadow: 0 6px 24px rgba(0,0,0,0.2); animation: soToastIn 0.3s ease;
      max-width: 300px;
    }
    @keyframes soToastIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  `;
  document.head.appendChild(style);

  // ── STATE ────────────────────────────────────────────
  let currentUser = JSON.parse(sessionStorage.getItem('user') || '{}');
  let myTickets = [];
  let activeTicketId = null;
  let soView = 'list';       // 'list' | 'new' | 'detail'
  let soFilter = 'tous';
  let selectedType = 'bug';
  let selectedPriorite = 'normale';
  let showMetaInfo = false;
  let ticketUnread = 0;
  const socket = window.io ? window.io() : null;

  // ── BUILD HTML ───────────────────────────────────────
  const fab = document.createElement('button');
  fab.id = 'support-fab';
  fab.title = 'Support & Demandes';
  fab.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="rgba(168,224,122,0.2)"/>
      <path d="M12 17h.01M12 13a2 2 0 000-4 2 2 0 00-2 2" stroke="#a8e07a" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="12" cy="12" r="9" stroke="#a8e07a" stroke-width="1.5"/>
    </svg>
    <div id="support-fab-badge">0</div>`;
  fab.onclick = toggleOverlay;

  const overlay = document.createElement('div');
  overlay.id = 'support-overlay';
  overlay.innerHTML = `
    <div id="support-backdrop"></div>
    <div id="support-panel">
      <div class="so-head">
        <div class="so-head-left">
          <div class="so-logo">🎯</div>
          <div>
            <div class="so-head-title">Centre de support</div>
            <div class="so-head-sub" id="so-head-sub">Chargement...</div>
          </div>
        </div>
        <button class="so-close" onclick="SupportOverlay.close()">×</button>
      </div>
      <div class="so-tabs">
        <div class="so-tab active" id="so-tab-list" onclick="SupportOverlay.setView('list')"> Mes demandes <span class="so-tab-badge" id="so-unread-badge" style="display:none">0</span></div>
        <div class="so-tab" id="so-tab-new" onclick="SupportOverlay.setView('new')">➕ Nouvelle demande</div>
      </div>
      <div class="so-body" id="so-body">

        <!-- VUE LISTE -->
        <div class="so-view active" id="so-view-list">
          <div class="so-filters" id="so-filters">
            <div class="so-filter-pill active" onclick="SupportOverlay.setFilter('tous',this)">Tous</div>
            <div class="so-filter-pill" onclick="SupportOverlay.setFilter('ouvert',this)">Ouverts</div>
            <div class="so-filter-pill" onclick="SupportOverlay.setFilter('en_cours',this)">En cours</div>
            <div class="so-filter-pill" onclick="SupportOverlay.setFilter('resolu',this)">Résolus</div>
          </div>
          <div class="so-list" id="so-list"></div>
        </div>

        <!-- VUE NOUVEAU TICKET -->
        <div class="so-view" id="so-view-new">
          <div class="so-form">
            <div class="so-field">
              <div class="so-label">Type de demande</div>
              <div class="so-chips" id="so-type-chips">
                <div class="so-chip sel-bug" onclick="SupportOverlay.selType('bug',this)"> Bug</div>
                <div class="so-chip" onclick="SupportOverlay.selType('question',this)"> Question</div>
                <div class="so-chip" onclick="SupportOverlay.selType('feature',this)"> Fonctionnalité</div>
                <div class="so-chip" onclick="SupportOverlay.selType('urgent',this)"> Urgent</div>
              </div>
            </div>
            <div class="so-field">
              <div class="so-label">Titre de la demande</div>
              <input class="so-input" id="so-titre" placeholder="Décrivez le problème en une phrase..." maxlength="120" />
            </div>
            <div class="so-field">
              <div class="so-label">Description détaillée</div>
              <textarea class="so-input so-textarea" id="so-desc" placeholder="Décrivez précisément le problème, les étapes pour le reproduire, ce que vous attendiez vs ce qui s'est passé..."></textarea>
            </div>
            <div class="so-field">
              <div class="so-label">Priorité</div>
              <div class="so-chips" id="so-prio-chips">
                <div class="so-chip" onclick="SupportOverlay.selPrio('critique',this)"> Critique</div>
                <div class="so-chip" onclick="SupportOverlay.selPrio('haute',this)"> Haute</div>
                <div class="so-chip sel-normale" onclick="SupportOverlay.selPrio('normale',this)"> Normale</div>
                <div class="so-chip" onclick="SupportOverlay.selPrio('basse',this)"> Basse</div>
              </div>
            </div>
            <div>
              <span class="so-meta-toggle" onclick="SupportOverlay.toggleMeta()"> Informations techniques (auto)</span>
              <div class="so-meta" id="so-meta-block" style="display:none;margin-top:8px"></div>
            </div>
            <button class="so-submit" id="so-submit-btn" onclick="SupportOverlay.submit()">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 10L18 2 10 18 9 11 2 10z" fill="#a8e07a"/></svg>
              Envoyer la demande
            </button>
          </div>
        </div>

        <!-- VUE DÉTAIL -->
        <div class="so-view" id="so-view-detail">
          <div class="so-detail" id="so-detail-content"></div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(fab);
  document.body.appendChild(overlay);

  document.getElementById('support-backdrop').onclick = () => SupportOverlay.close();

  // ── META AUTO ────────────────────────────────────────
  const metaInfo = {
    page: window.location.pathname,
    url: window.location.href,
    navigateur: navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'Inconnu',
    resolution: `${window.screen.width}×${window.screen.height}`,
    horodatage: new Date().toLocaleString('fr-FR')
  };
  document.getElementById('so-meta-block').innerHTML = Object.entries(metaInfo).map(([k,v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('');

  // ── FONCTIONS ────────────────────────────────────────
  function toggleOverlay() {
    const o = document.getElementById('support-overlay');
    if (o.classList.contains('open')) { SupportOverlay.close(); }
    else { o.classList.add('open'); loadMyTickets(); }
  }

  async function loadMyTickets() {
    const rid = currentUser.restaurantId || '';
    if (!rid) { document.getElementById('so-head-sub').textContent = 'Non connecté'; return; }
    const res = await fetch(`/tickets/restaurant/${rid}`);
    myTickets = await res.json();
    const unread = myTickets.filter(t => t.comments.some(c => c.from==='admin' && !t._readComments?.includes(c.id))).length;
    document.getElementById('so-head-sub').textContent = `${myTickets.length} demande${myTickets.length>1?'s':''} · ${currentUser.restaurant||currentUser.nom||'—'}`;
    renderTicketList();
    // Badge FAB
    const newComments = myTickets.reduce((s,t) => s + t.comments.filter(c=>c.from==='admin').length, 0);
    const readCount = parseInt(localStorage.getItem('so_read_'+rid)||'0');
    ticketUnread = Math.max(0, newComments - readCount);
    updateFabBadge();
  }

  function renderTicketList() {
    const list = document.getElementById('so-list');
    let filtered = myTickets;
    if (soFilter !== 'tous') filtered = myTickets.filter(t => t.statut === soFilter);
    if (!filtered.length) {
      list.innerHTML = `<div class="so-empty"><div class="so-empty-icon">${soFilter==='resolu'?'✅':'📭'}</div><div class="so-empty-text">${soFilter==='tous'?'Aucune demande.<br>Créez votre première demande !':'Aucun ticket dans cette catégorie.'}</div></div>`;
      return;
    }
    list.innerHTML = filtered.map(t => {
      const s = STATUTS[t.statut] || STATUTS.ouvert;
      const adminComments = t.comments.filter(c => c.from==='admin').length;
      const prog = t.progress || PROGRESS_LABELS[t.statut] || 0;
      const prioColors = { critique:'#fef0f0|#e05555', haute:'#fff8ec|#e08a10', normale:'#fffcec|#807010', basse:'#f0f7e8|#2d6a0a' };
      const [pbg,pc] = (prioColors[t.priorite]||'#f5f5f5|#666').split('|');
      return `<div class="so-ticket-item ${activeTicketId===t.id?'active':''}" onclick="SupportOverlay.openDetail('${t.id}')">
        <div class="so-ticket-top">
          <div style="flex:1;min-width:0">
            <div class="so-ticket-id">${t.id} · ${TYPES[t.type]||t.type}</div>
            <div class="so-ticket-title">${t.titre}</div>
          </div>
          <div class="so-ticket-badges">
            <span class="so-badge" style="background:${s.bg};color:${s.color}">${s.label}</span>
            <span class="so-badge" style="background:${pbg};color:${pc}">${t.priorite}</span>
            ${adminComments ? `<span class="so-new-badge">${adminComments} rép.</span>` : ''}
          </div>
        </div>
        <div class="so-ticket-progress"><div class="so-ticket-progress-fill" style="width:${prog}%"></div></div>
        <div class="so-ticket-footer">
          <span>${t.comments.length} commentaire${t.comments.length>1?'s':''}</span>
          <span>${timeAgo(t.updatedAt||t.createdAt)}</span>
        </div>
      </div>`;
    }).join('');
  }

  function renderDetail(ticketId) {
    const t = myTickets.find(t => t.id === ticketId);
    if (!t) return;
    const s = STATUTS[t.statut] || STATUTS.ouvert;
    const sla = slaInfo(t);
    const prog = t.progress || PROGRESS_LABELS[t.statut] || 0;
    const isResolved = t.statut === 'resolu' || t.statut === 'ferme';

    let slaHtml = '';
    if (sla) {
      const cls = sla.breached ? 'breach' : sla.pct > 70 ? 'warn' : 'ok';
      slaHtml = `<div class="so-sla ${cls}">
        ${sla.breached ? '⚠️ SLA dépassé' : `⏱ SLA: ${sla.remaining.toFixed(1)}h restantes (cible: ${sla.target}h)`}
        <div style="flex:1;height:3px;background:rgba(0,0,0,0.1);border-radius:3px;margin-left:6px;overflow:hidden">
          <div style="height:100%;width:${sla.pct}%;background:currentColor;opacity:0.5;border-radius:3px"></div>
        </div>
      </div>`;
    }

    const commentsHtml = t.comments.filter(c => !c.internal).map(c => `
      <div class="so-comment">
        <div class="so-comment-avatar ${c.from}">${c.from==='admin'?'AD':(c.fromName||'R').slice(0,2).toUpperCase()}</div>
        <div class="so-comment-bubble">
          <div class="so-comment-head">
            <span class="so-comment-author">${c.fromName||c.from}</span>
            <span class="so-comment-time">${fmtDateTime(c.timestamp)}</span>
          </div>
          <div class="so-comment-content ${c.from}">${c.content.replace(/\n/g,'<br>')}</div>
        </div>
      </div>`).join('');

    const ratingHtml = isResolved && !t.rating ? `
      <div>
        <div class="so-section-title">⭐ Évaluer la résolution</div>
        <div class="so-rating" id="so-rating-stars">
          ${[1,2,3,4,5].map(i=>`<span class="so-star" onclick="SupportOverlay.rate('${t.id}',${i})" onmouseover="SupportOverlay.hoverStar(${i})" onmouseout="SupportOverlay.unhoverStar()">⭐</span>`).join('')}
        </div>
      </div>` : t.rating ? `<div style="font-size:12px;color:#5a8a5a">✅ Évalué : ${'⭐'.repeat(t.rating)} (${t.rating}/5)</div>` : '';

    document.getElementById('so-detail-content').innerHTML = `
      <div class="so-detail-head">
        <button class="so-back" onclick="SupportOverlay.setView('list')">← Retour à la liste</button>
        <div class="so-ticket-id" style="margin-bottom:4px">${t.id} · ${fmtDateTime(t.createdAt)}</div>
        <div class="so-detail-title">${t.titre}</div>
        <div class="so-detail-meta">
          <span class="so-badge" style="background:${s.bg};color:${s.color};font-size:11px;padding:3px 9px">${s.label}</span>
          <span class="so-badge" style="background:#f5eeff;color:#7030c0;font-size:11px;padding:3px 9px">${TYPES[t.type]||t.type}</span>
          <span class="so-badge" style="background:#f0f0f0;color:#555;font-size:11px;padding:3px 9px">${PRIORITES[t.priorite]||t.priorite}</span>
        </div>
        <div class="so-progress-bar"><div class="so-progress-fill" style="width:${prog}%"></div></div>
        <div class="so-progress-pct">${prog}% complété</div>
        ${slaHtml}
      </div>
      <div class="so-detail-body">
        <div>
          <div class="so-section-title">📄 Description</div>
          <div class="so-desc-block">${t.description.replace(/\n/g,'<br>')}</div>
        </div>
        ${t.adminNote ? `<div><div class="so-section-title">📝 Note de l'équipe</div><div class="so-desc-block" style="background:#f0f7e8;border-color:#c8e8a0;color:#1a3a1a">${t.adminNote.replace(/\n/g,'<br>')}</div></div>` : ''}
        <div>
          <div class="so-section-title">💬 Échanges <span style="font-weight:400;color:#bbb">${t.comments.filter(c=>!c.internal).length} message${t.comments.filter(c=>!c.internal).length>1?'s':''}</span></div>
          <div class="so-timeline">${commentsHtml || '<div style="font-size:12px;color:#ccc;padding:8px 0">En attente de réponse de notre équipe...</div>'}</div>
        </div>
        ${!isResolved ? `
        <div class="so-reply-area">
          <div class="so-section-title">✉️ Ajouter une précision</div>
          <div class="so-reply-wrap">
            <textarea class="so-reply-input" id="so-reply-input" placeholder="Apportez des précisions ou répondez..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();SupportOverlay.sendReply('${t.id}')}"></textarea>
            <button class="so-reply-btn" onclick="SupportOverlay.sendReply('${t.id}')">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 10L18 2 10 18 9 11 2 10z" fill="#a8e07a"/></svg>
            </button>
          </div>
        </div>` : ''}
        ${ratingHtml}
        <div>
          <div class="so-section-title">🔧 Informations techniques</div>
          <div class="so-meta-info">
            ${Object.entries(t.metadata||{}).map(([k,v])=>`<div class="so-meta-row"><span class="so-meta-key">${k}</span><span>${v}</span></div>`).join('') || '<span style="color:#ccc">Aucune info technique</span>'}
          </div>
        </div>
      </div>`;
  }

  function updateFabBadge() {
    const badge = document.getElementById('support-fab-badge');
    const unreadBadge = document.getElementById('so-unread-badge');
    if (ticketUnread > 0) {
      badge.textContent = ticketUnread; badge.classList.add('show');
      if (unreadBadge) { unreadBadge.textContent = ticketUnread; unreadBadge.style.display='inline'; }
    } else {
      badge.classList.remove('show');
      if (unreadBadge) unreadBadge.style.display='none';
    }
  }

  function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'so-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── API PUBLIC ───────────────────────────────────────
  window.SupportOverlay = {
    close() { document.getElementById('support-overlay').classList.remove('open'); },
    setView(v) {
      soView = v;
      document.querySelectorAll('.so-view').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.so-tab').forEach(el => el.classList.remove('active'));
      document.getElementById('so-view-' + v).classList.add('active');
      const tabMap = { list:'so-tab-list', new:'so-tab-new', detail:'so-tab-list' };
      const tab = document.getElementById(tabMap[v]);
      if (tab) tab.classList.add('active');
      if (v === 'list') renderTicketList();
    },
    setFilter(f, el) {
      soFilter = f;
      document.querySelectorAll('.so-filter-pill').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      renderTicketList();
    },
    selType(type, el) {
      selectedType = type;
      document.querySelectorAll('#so-type-chips .so-chip').forEach(c => { c.className = 'so-chip'; });
      el.classList.add('sel-' + type);
    },
    selPrio(prio, el) {
      selectedPriorite = prio;
      document.querySelectorAll('#so-prio-chips .so-chip').forEach(c => { c.className = 'so-chip'; });
      el.classList.add('sel-' + prio);
    },
    toggleMeta() {
      showMetaInfo = !showMetaInfo;
      document.getElementById('so-meta-block').style.display = showMetaInfo ? 'block' : 'none';
    },
    async submit() {
      const titre = document.getElementById('so-titre').value.trim();
      const desc = document.getElementById('so-desc').value.trim();
      if (!titre) { showToast('⚠️ Veuillez saisir un titre'); return; }
      if (desc.length < 10) { showToast('⚠️ Description trop courte (min 10 car.)'); return; }
      const btn = document.getElementById('so-submit-btn');
      btn.disabled = true; btn.textContent = 'Envoi en cours...';
      const rid = currentUser.restaurantId || '';
      const payload = {
        restaurantId: rid,
        restaurantNom: currentUser.restaurant || currentUser.nom || rid,
        titre, description: desc,
        type: selectedType, priorite: selectedPriorite,
        metadata: { ...metaInfo, horodatage: new Date().toLocaleString('fr-FR') }
      };
      const res = await fetch('/tickets', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await res.json();
      btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M2 10L18 2 10 18 9 11 2 10z" fill="#a8e07a"/></svg> Envoyer la demande';
      if (data.success) {
        document.getElementById('so-titre').value = '';
        document.getElementById('so-desc').value = '';
        showToast('✅ Demande envoyée ! ID: ' + data.ticket.id);
        await loadMyTickets();
        this.setView('list');
      } else { showToast('❌ Erreur: ' + (data.error||'inconnue')); }
    },
    openDetail(ticketId) {
      activeTicketId = ticketId;
      this.setView('detail');
      renderDetail(ticketId);
      // Marquer lu
      const rid = currentUser.restaurantId || '';
      const t = myTickets.find(t=>t.id===ticketId);
      if (t) { localStorage.setItem('so_read_'+rid, t.comments.filter(c=>c.from==='admin').length); }
      ticketUnread = 0; updateFabBadge();
    },
    async sendReply(ticketId) {
      const input = document.getElementById('so-reply-input');
      const content = input?.value.trim();
      if (!content) return;
      input.value = '';
      const rid = currentUser.restaurantId || '';
      await fetch(`/tickets/${ticketId}/comment`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ from:'restaurant', fromName: currentUser.restaurant||currentUser.nom||'Restaurant', content })
      });
      showToast('✅ Réponse envoyée');
      await loadMyTickets();
      renderDetail(ticketId);
    },
    async rate(ticketId, stars) {
      await fetch(`/tickets/${ticketId}/rate`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ rating: stars }) });
      showToast('⭐ Merci pour votre évaluation !');
      await loadMyTickets();
      renderDetail(ticketId);
    },
    hoverStar(n) {
      document.querySelectorAll('.so-star').forEach((s,i) => { s.classList.toggle('active', i<n); });
    },
    unhoverStar() {
      document.querySelectorAll('.so-star').forEach(s => s.classList.remove('active'));
    }
  };

  // ── SOCKET ───────────────────────────────────────────
  if (socket) {
    const rid = currentUser.restaurantId || '';
    socket.on(`ticket_update_${rid}`, async (t) => {
      await loadMyTickets();
      if (activeTicketId === t.id && soView === 'detail') renderDetail(t.id);
      showToast(`📋 Ticket ${t.id} mis à jour : ${STATUTS[t.statut]?.label||t.statut}`);
    });
    socket.on(`ticket_comment_${rid}`, async ({ ticketId }) => {
      const prevRead = parseInt(localStorage.getItem('so_read_'+rid)||'0');
      await loadMyTickets();
      const t = myTickets.find(t=>t.id===ticketId);
      const newAdminComments = t ? t.comments.filter(c=>c.from==='admin').length : 0;
      ticketUnread = Math.max(0, newAdminComments - prevRead);
      updateFabBadge();
      if (activeTicketId === ticketId && soView === 'detail') renderDetail(ticketId);
      showToast('💬 Nouvelle réponse sur votre ticket ' + ticketId);
    });
  }
})();
