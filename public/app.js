import { CANDIDATOS, REGIOES, ESTADOS, carregarTSE } from './data.js';
import { agregar, projetar, fmtInt, fmtPct, situacao as calcSituacao, alertaResultado } from './calc.js';
import { estimar, previaDe, pesoApuracao, comparar1T, APURACAO_PLENA, LULA, FLAVIO } from './calibracao.js';
import { GRUPOS, NOVOS, FONTES, normalizar, queryDeParams, votosSegundoTurno } from './transferencia.js';
import { criarMapa3D, alturaDe, ALT_MAX } from './mapa3d.js';

const $ = (id) => document.getElementById(id);
const fmtMi = (v) => (v >= 1e6 ? `${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi` : fmtInt.format(v));
const cand = Object.fromEntries(CANDIDATOS.map((c) => [c.id, c]));

// turno em andamento (o servidor troca sozinho para o 2º quando o TSE começa a totalizá-lo)
const TURNO = await fetch('/api/turno', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ turno: 1, eleicao: '6257' }));
// estimativa do 2º turno: prévia (1º turno + pesquisas) e curvas aprendidas com o 1º turno encerrado (calibracao.js)
let CAL = TURNO.turno === 2 ? await fetch('/api/calibracao').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;

const state = {
  escopo: { tipo: 'br', id: 'BR' },
  estados: [],
  atualizado: null,   // horário do último arquivo do TSE
  erro: null,
  ordem: { chave: 'uf', dir: 1 },
  munis: [],          // resultado por município (unidade do mapa 3D)
  munisLidoEm: null,
  foco: null,         // { uf, cidade: ibge selecionado (com borda) | null = estado inteiro }
};

const doEscopo = (esc) => {
  if (esc.tipo === 'uf') return state.estados.filter((e) => e.uf === esc.id);
  if (esc.tipo === 'regiao') return state.estados.filter((e) => e.regiao === esc.id);
  return state.estados;
};
const nomeEscopo = (esc) =>
  esc.tipo === 'uf' ? ESTADOS.find((e) => e.uf === esc.id).nome : esc.tipo === 'regiao' ? REGIOES[esc.id].nome : 'Brasil';

// ---------- gráficos ----------
Chart.defaults.font.family = 'system-ui, sans-serif';
let chartSel, chartReg;
const pizzas = {};
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function criarCharts() {
  Chart.defaults.color = cssVar('--muted');
  const grid = { color: cssVar('--line') };
  chartSel = new Chart($('chart-sel'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 4 }] },
    options: {
      indexAxis: 'y', maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtPct(c.parsed.x)}` } } },
      scales: { x: { min: 0, grid, ticks: { callback: (v) => `${v}%` } }, y: { grid: { display: false } } },
    },
  });
  const pie = (id) => new Chart($(id), {
    type: 'pie', data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: cssVar('--card'), borderWidth: 2 }] },
    options: { maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => ` ${c.label}: ${id === 'pizza-eleit' ? fmtInt.format(c.parsed) : fmtPct(c.parsed)}` } } } },
  });
  for (const id of ['pizza-real', 'pizza-proj', 'pizza-eleit', 'pizza-st', 'pizza-stc']) pizzas[id] = pie(id);
  criarChartsST(grid);
  chartReg = new Chart($('chart-reg'), {
    type: 'bar',
    data: { labels: [], datasets: [] },
    options: {
      indexAxis: 'y', maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPct(c.parsed.x)}` } } },
      scales: { x: { stacked: true, max: 100, grid, ticks: { callback: (v) => `${v}%` } }, y: { stacked: true, grid: { display: false } } },
    },
  });
}

// ---------- render ----------
function renderKpis() {
  const br = agregar(state.estados);
  const l = br.ranking[0], s = br.ranking[1];
  const sit = calcSituacao(state.estados);
  const alerta = alertaResultado(sit, 'para Presidente');
  $('alerta').className = alerta ? `alerta ${alerta.tipo}` : 'alerta';
  $('alerta').innerHTML = alerta ? alerta.html : '';
  const situacao = sit.eleito ? `${l.nome} eleito(a) no 1º turno` : sit.segundoTurno ? 'Haverá 2º turno'
    : br.pct[l.id] > 50 ? `${l.nome} acima de 50% (ainda pode cair)` : 'Em apuração';
  const det = `${fmtInt.format(br.validos)} votos válidos`;
  $('kpis').innerHTML = `
    <div class="kpi"><div class="l">Apuração Brasil</div><div class="v">${fmtPct(br.apuracao)}</div><div class="s">das seções totalizadas</div></div>
    <div class="kpi"><div class="l">Eleitorado total</div><div class="v">${fmtInt.format(br.eleitorado)}</div><div class="s">eleitores aptos</div></div>
    <div class="kpi"><div class="l">Líder</div><div class="v" style="color:${l.cor}">${fmtPct(br.pct[l.id])}</div><div class="s">${l.nome} (${l.partido})</div></div>
    <div class="kpi"><div class="l">2º colocado</div><div class="v" style="color:${s.cor}">${fmtPct(br.pct[s.id])}</div><div class="s">${s.nome} · diferença ${fmtPct(br.pct[l.id] - br.pct[s.id], 2).replace('%', ' p.p.')}</div></div>
    <div class="kpi"><div class="l">Situação</div><div class="v" style="font-size:1.1rem;line-height:1.9rem">${situacao}</div><div class="s">${det}</div></div>`;
}

function renderEscopo() {
  const itens = [{ tipo: 'br', id: 'BR', nome: 'Brasil' }, ...Object.entries(REGIOES).map(([id, r]) => ({ tipo: 'regiao', id, nome: r.nome }))];
  $('escopo').innerHTML = itens.map((i) => {
    const ativo = state.escopo.tipo === i.tipo && state.escopo.id === i.id
      || (state.escopo.tipo === 'uf' && i.tipo === 'regiao' && ESTADOS.find((e) => e.uf === state.escopo.id).regiao === i.id);
    return `<button class="chip" aria-pressed="${ativo}" data-tipo="${i.tipo}" data-id="${i.id}">${i.nome}</button>`;
  }).join('');
}

const pilha = (a) => `<div class="pilha">${CANDIDATOS.map((c) => `<i style="width:${a.pct[c.id]}%;background:${c.cor}" title="${c.nome} ${fmtPct(a.pct[c.id])}"></i>`).join('')}</div>`;

function renderRegioes() {
  $('regioes').innerHTML = Object.entries(REGIOES).map(([id, r]) => {
    const a = agregar(state.estados.filter((e) => e.regiao === id));
    const ativo = state.escopo.tipo === 'regiao' && state.escopo.id === id;
    return `<button class="reg" aria-pressed="${ativo}" data-tipo="regiao" data-id="${id}">
      <div class="linha"><b>${r.nome}</b><span class="num">${fmtPct(a.apuracao)} apurado</span></div>
      <div class="barra"><i style="width:${a.apuracao}%"></i></div>
      ${pilha(a)}
      <div class="meta"><span>Eleitorado: <b>${fmtInt.format(a.eleitorado)}</b></span>
        <span>${a.lider && a.validos ? `<b style="color:${a.lider.cor}">${a.lider.nome} ${fmtPct(a.pct[a.lider.id], 1)}</b>` : '—'}</span></div>
    </button>`;
  }).join('');
}

function renderDetalhe() {
  const lista = doEscopo(state.escopo);
  const a = agregar(lista);
  const isUf = state.escopo.tipo === 'uf';
  $('det-titulo').textContent = `${nomeEscopo(state.escopo)} · resultado`;
  $('det-meta').innerHTML = `
    <span>Apuração: <b>${fmtPct(a.apuracao)}</b></span>
    <span>Eleitorado: <b>${fmtInt.format(a.eleitorado)}</b></span>
    <span>Votos válidos: <b>${fmtInt.format(a.validos)}</b></span>
    <span>Seções: <b>${fmtInt.format(lista.reduce((s, e) => s + e.secoes.apuradas, 0))}</b> de ${fmtInt.format(lista.reduce((s, e) => s + e.secoes.total, 0))}</span>
    ${isUf ? `<span>Região: <b>${REGIOES[lista[0].regiao].nome}</b></span>` : `<span>Estados: <b>${lista.length}</b></span>`}`;
  const ord = [...CANDIDATOS].sort((x, y) => a.pct[y.id] - a.pct[x.id]);
  chartSel.data.labels = ord.map((c) => c.nome);
  chartSel.data.datasets[0].data = ord.map((c) => a.pct[c.id]);
  chartSel.data.datasets[0].backgroundColor = ord.map((c) => c.cor);
  chartSel.update();
  $('det-cands').innerHTML = ord.map((c) => `<li><span class="dot" style="background:${c.cor}"></span>
    <span>${c.nome} <span class="muted">${c.partido}</span></span><span class="votos">${fmtInt.format(a.votos[c.id])}</span><span class="pct">${fmtPct(a.pct[c.id])}</span></li>`).join('');
}

function renderComparativo() {
  const grupos = [['Brasil', state.estados], ...Object.entries(REGIOES).map(([id, r]) => [r.nome, state.estados.filter((e) => e.regiao === id)])];
  const aggs = grupos.map(([, l]) => agregar(l));
  chartReg.data.labels = grupos.map(([n], i) => `${n} (${fmtPct(aggs[i].apuracao, 0)})`);
  chartReg.data.datasets = CANDIDATOS.map((c) => ({ label: c.nome, backgroundColor: c.cor, data: aggs.map((a) => a.pct[c.id]) }));
  chartReg.update();
}

function renderTabela() {
  const esc = state.escopo;
  const regiaoAlvo = esc.tipo === 'br' ? null : esc.tipo === 'regiao' ? esc.id : ESTADOS.find((e) => e.uf === esc.id).regiao;
  let rows = state.estados.filter((e) => !regiaoAlvo || e.regiao === regiaoAlvo).map((e) => ({ e, a: agregar([e]) }));
  const { chave, dir } = state.ordem;
  const val = (r) => ({ uf: r.e.nome, apuracao: r.e.apuracao, eleitorado: r.e.eleitorado }[chave] ?? r.a.pct[chave]);
  rows.sort((x, y) => (val(x) > val(y) ? 1 : val(x) < val(y) ? -1 : 0) * dir);
  $('tab-titulo').textContent = `Estados${regiaoAlvo ? ` · ${REGIOES[regiaoAlvo].nome}` : ' · todos'}`;
  const cs = CANDIDATOS.filter((c) => c.destaque);
  const th = (k, t) => `<th data-k="${k}">${t}${chave === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  $('tabela').innerHTML = `<thead><tr>${th('uf', 'Estado')}<th>Região</th>${th('apuracao', 'Apurado')}${th('eleitorado', 'Eleitorado')}
    <th>Líder</th>${cs.map((c) => th(c.id, `<span style="color:${c.cor}">●</span> ${c.nome.split(' ').pop()}`)).join('')}</tr></thead>
    <tbody>${rows.map(({ e, a }) => {
      const sel = esc.tipo === 'uf' && esc.id === e.uf;
      return `<tr data-tipo="uf" data-id="${e.uf}" class="${sel ? 'sel' : ''}">
        <td>${e.nome} <span class="muted">${e.uf === 'ZZ' ? '' : e.uf}</span></td><td>${REGIOES[e.regiao].nome}</td>
        <td>${fmtPct(e.apuracao, 1)}<span class="mini"><i style="width:${e.apuracao}%"></i></span></td>
        <td>${fmtInt.format(e.eleitorado)}</td>
        <td class="lider" style="color:${a.lider ? a.lider.cor : 'inherit'}">${a.validos ? a.lider.nome : '—'}</td>
        ${cs.map((c) => `<td>${a.validos ? `<span class="${a.lider && a.lider.id === c.id ? 'win' : ''}">${fmtPct(a.pct[c.id], 1)}</span>` : '—'}</td>`).join('')}</tr>`;
    }).join('')}</tbody>`;
}

function renderPizzas() {
  const lista = doEscopo(state.escopo);
  const nome = nomeEscopo(state.escopo);
  const fatias = (a) => {  // candidatos abaixo de 1,5% viram "Demais" para a pizza ficar legível
    const grandes = [...CANDIDATOS].filter((c) => a.pct[c.id] >= 1.5).sort((x, y) => a.pct[y.id] - a.pct[x.id]);
    const resto = 100 - grandes.reduce((s, c) => s + a.pct[c.id], 0);
    const v = grandes.map((c) => ({ n: c.nome, v: a.pct[c.id], c: c.cor }));
    return resto > 0.05 && a.validos ? [...v, { n: 'Demais', v: resto, c: '#94a3b8' }] : v;
  };
  const set = (id, itens, titulo) => {
    const ch = pizzas[id];
    ch.data.labels = itens.map((x) => x.n);
    ch.data.datasets[0].data = itens.map((x) => x.v);
    ch.data.datasets[0].backgroundColor = itens.map((x) => x.c);
    ch.update();
    $(`${id}-t`).textContent = titulo;
    $(`${id}-l`).innerHTML = itens.map((x) => `<span style="--c:${x.c}">${x.n} <b>${id === 'pizza-eleit' ? fmtPct(x.v / lista.reduce((s, e) => s + e.eleitorado, 0) * 100, 1) : fmtPct(x.v, 1)}</b></span>`).join('');
  };
  set('pizza-real', fatias(agregar(lista)), `Votos válidos hoje · ${nome}`);
  set('pizza-proj', fatias(agregar(lista.map(projetar))), `Projeção com 100% apurado · ${nome}`);
  const regs = Object.entries(REGIOES).map(([id, r]) => ({ n: r.nome, v: state.estados.filter((e) => e.regiao === id).reduce((s, e) => s + e.eleitorado, 0), c: ['#0ea5e9', '#f97316', '#84cc16', '#8b5cf6', '#14b8a6', '#94a3b8'][Object.keys(REGIOES).indexOf(id)] }));
  // eleitorado sempre do Brasil, por região
  const totalBR = regs.reduce((s, x) => s + x.v, 0);
  const ch = pizzas['pizza-eleit'];
  ch.data.labels = regs.map((x) => x.n); ch.data.datasets[0].data = regs.map((x) => x.v); ch.data.datasets[0].backgroundColor = regs.map((x) => x.c); ch.update();
  $('pizza-eleit-t').textContent = `Eleitorado por região · ${fmtInt.format(totalBR)} eleitores`;
  $('pizza-eleit-l').innerHTML = regs.map((x) => `<span style="--c:${x.c}">${x.n} <b>${fmtPct(x.v / totalBR * 100, 1)}</b></span>`).join('');
}

// ---------- cenário: Lula melhora nos votos que faltam ----------
const lerNum = (id, padrao) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.max(0, v) : padrao; };

function renderCenario() {
  const pp = lerNum('cen-pp', 35), rel = lerNum('cen-rel', 20);
  const tot = Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
  const neutro = Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
  let faltaTotal = 0, secFaltam = 0;

  const linhas = Object.entries(REGIOES).map(([id, r]) => {
    const l = state.estados.filter((e) => e.regiao === id);
    const h = agregar(l), p = agregar(l.map(projetar));
    const falta = Math.max(0, p.validos - h.validos);
    const faltamSec = l.reduce((s, e) => s + e.secoes.total - e.secoes.apuradas, 0);
    faltaTotal += falta; secFaltam += faltamSec;
    const lulaHoje = h.pct[LULA];
    const lidera = h.validos > 0 && h.lider.id === LULA;
    const lulaNovo = Math.min(100, lidera ? lulaHoje + pp : lulaHoje * (1 + rel / 100));
    const outros = 100 - lulaHoje;
    // demais candidatos perdem o que Lula ganha, na proporção do que cada um tem hoje
    const share = (c) => (c.id === LULA ? lulaNovo : outros > 0 ? (h.pct[c.id] * (100 - lulaNovo)) / outros : 0);
    for (const c of CANDIDATOS) {
      tot[c.id] += h.votos[c.id] + (falta * share(c)) / 100;
      neutro[c.id] += p.votos[c.id];
    }
    const final = h.votos[LULA] + (falta * lulaNovo) / 100;
    const base = h.validos + falta;
    return `<tr><td>${r.nome}</td><td>${fmtPct(h.apuracao, 1)}</td><td>${fmtInt.format(faltamSec)}</td>
      <td>${fmtInt.format(h.validos)}</td><td><b>${fmtInt.format(Math.round(falta))}</b></td>
      <td>${h.validos ? `<span style="color:${h.lider.cor}">${h.lider.nome}</span>` : '—'}</td>
      <td>${fmtPct(lulaHoje, 1)}</td><td style="color:${CANDIDATOS.find((c) => c.id === LULA).cor}"><b>${fmtPct(lulaNovo, 1)}</b> <span class="muted">${lidera ? `(+${pp} p.p.)` : `(×${(1 + rel / 100).toLocaleString('pt-BR')})`}</span></td>
      <td>${base ? fmtPct((final / base) * 100, 1) : '—'}</td></tr>`;
  });

  $('cen-regioes').innerHTML = `<thead><tr><th>Região</th><th>Apurado</th><th>Seções faltando</th><th>Votos válidos apurados</th><th>Votos válidos que faltam (est.)</th>
    <th>Líder hoje</th><th>Lula hoje</th><th>Lula nos que faltam</th><th>Lula final na região</th></tr></thead><tbody>${linhas.join('')}</tbody>
    <tfoot><tr><td><b>Brasil</b></td><td></td><td>${fmtInt.format(secFaltam)}</td><td></td><td><b>${fmtInt.format(Math.round(faltaTotal))}</b></td><td colspan="4"></td></tr></tfoot>`;

  const soma = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const sN = soma(neutro), sC = soma(tot);
  const pct = (o, s, c) => (s ? (o[c.id] / s) * 100 : 0);
  const ord = [...CANDIDATOS].sort((x, y) => tot[y.id] - tot[x.id]);
  $('cen-nacional').innerHTML = `<thead><tr><th>Candidato (Brasil)</th><th>Projeção neutra</th><th>Cenário</th><th>Variação</th><th>Votos no cenário</th></tr></thead><tbody>${ord.slice(0, 6).map((c) => {
    const d = pct(tot, sC, c) - pct(neutro, sN, c);
    return `<tr><td><span style="color:${c.cor}">●</span> ${c.nome}</td><td>${fmtPct(pct(neutro, sN, c))}</td><td><b>${fmtPct(pct(tot, sC, c))}</b></td>
      <td style="color:${d >= 0 ? '#16a34a' : '#dc2626'}">${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.</td><td>${fmtInt.format(Math.round(tot[c.id]))}</td></tr>`; }).join('')}</tbody>`;
  const l1 = ord[0], l2 = ord[1];
  $('cen-veredito').innerHTML = !sC ? '' : pct(tot, sC, l1) > 50
    ? `Neste cenário, <b style="color:${l1.cor}">${l1.nome}</b> venceria no 1º turno (${fmtPct(pct(tot, sC, l1))}).`
    : `Neste cenário haveria <b>2º turno</b>: <b style="color:${l1.cor}">${l1.nome}</b> ${fmtPct(pct(tot, sC, l1))} × <b style="color:${l2.cor}">${l2.nome}</b> ${fmtPct(pct(tot, sC, l2))}.`;
}

// ---------- 2º turno: Lula × Flávio (transferência de votos do 1º turno; taxas em transferencia.js) ----------
const cLula = cand[LULA], cFlavio = cand[FLAVIO];
const LINHAS_PARAMS = [...GRUPOS, NOVOS];
const ppf2 = (d) => `${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.`;

function initSegundoTurno() {
  $('st-params').innerHTML = `<thead><tr><th>Eleitor do 1º turno de…</th><th>Eleitores no 1º turno</th><th style="color:${cFlavio.cor}">→ Flávio (%)</th><th style="color:${cLula.cor}">→ Lula (%)</th><th>→ Branco/nulo/indeciso</th></tr></thead><tbody>${LINHAS_PARAMS.map((g) => `
    <tr><td>${g.nome}${g.chave === 'novos' ? `<br><span class="muted"><input id="st-c-novos" type="number" min="0" max="100" step="1" value="${NOVOS.comparecem}"> % deles votam no 2º turno</span>` : ''}</td>
    <td id="st-n-${g.chave}">—</td><td><input id="st-f-${g.chave}" type="number" min="0" max="100" step="0.1" value="${g.f}"></td>
    <td><input id="st-l-${g.chave}" type="number" min="0" max="100" step="0.1" value="${g.l}"></td><td id="st-s-${g.chave}">—</td></tr>`).join('')}</tbody>`;
  for (const el of document.querySelectorAll('#st-params input, #st-base, #stc-pct, #stc-fonte')) el.addEventListener('input', aoEditarST);
}

/** Taxas digitadas no painel, no formato de transferencia.js (f + l ≤ 100 em cada linha). */
function paramsST() {
  const p = Object.fromEntries(LINHAS_PARAMS.map((g) => [g.chave, { f: $(`st-f-${g.chave}`).value, l: $(`st-l-${g.chave}`).value }]));
  p.novos.comparecem = $('st-c-novos').value;
  return normalizar(p);
}

let timerST = null;
function aoEditarST() {
  if (TURNO.turno === 1) { if (state.estados.length) renderSegundoTurno(); return; }
  // 2º turno: as curvas de correção dependem das taxas → o servidor recalcula (barato) e o painel inteiro é redesenhado
  clearTimeout(timerST);
  timerST = setTimeout(async () => {
    try {
      const r = await fetch(`/api/calibracao?${queryDeParams(paramsST())}`, { cache: 'no-store' });
      if (r.ok) { CAL = await r.json(); if (state.estados.length) render(); }
    } catch (err) { console.error('Falha ao recalcular a estimativa:', err); }
  }, 350);
}

/** Preenche as colunas "eleitores no 1º turno" e "branco/nulo" da tabela de taxas. `agg` = { votos, abstencao } do 1º turno. */
function preencherParamsST(params, agg) {
  for (const g of LINHAS_PARAMS) {
    const q = params[g.chave];
    const n = g.chave === 'novos' ? ((agg.abstencao || 0) * q.comparecem) / 100 : g.ids.reduce((s, id) => s + (agg.votos[id] || 0), 0);
    $(`st-n-${g.chave}`).innerHTML = g.chave === 'novos' ? `${fmtInt.format(Math.round(n))} <span class="muted">de ${fmtInt.format(Math.round(agg.abstencao || 0))} abstenções</span>` : fmtInt.format(Math.round(n));
    $(`st-s-${g.chave}`).innerHTML = q.excede ? '<span class="aviso">soma > 100%: ajustado</span>' : fmtPct(Math.max(0, 100 - q.f - q.l), 1);
  }
}

/** Cenário: Lula recebe `bonus`% a mais de cada grupo; o extra sai de Flávio (ou dos brancos/nulos), nunca além do que existe. */
function aplicarBonus(params, bonusPct, fonte) {
  return Object.fromEntries(Object.entries(params).map(([k, g]) => {
    const extra = g.l * (bonusPct / 100);
    const tira = Math.min(extra, fonte === 'flavio' ? g.f : Math.max(0, 100 - g.f - g.l));
    return [k, { ...g, l: g.l + tira, f: fonte === 'flavio' ? g.f - tira : g.f }];
  }));
}

/** Agregado do 1º turno de um conjunto de unidades: votos por candidato e abstenção. */
const agg1 = (unidades) => ({ votos: agregar(unidades).votos, abstencao: unidades.reduce((s, e) => s + (e.abstencao || 0), 0) });
/** Votos de Lula e Flávio no 2º turno para um conjunto de unidades do 1º turno (já na base escolhida). */
const calcST = (unidades, params) => votosSegundoTurno(agg1(unidades), params);

const chartsST = {};
function criarChartsST(grid) {
  for (const p of ['st', 'stc']) {
    chartsST[p] = new Chart($(`chart-${p}`), {
      type: 'bar', data: { labels: [], datasets: [] },
      options: { indexAxis: 'y', maintainAspectRatio: false, animation: { duration: 400 },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPct(c.parsed.x)}` } } },
        scales: { x: { stacked: true, max: 100, grid, ticks: { callback: (v) => `${v}%` } }, y: { stacked: true, grid: { display: false } } } },
    });
  }
}

/** Desenha um bloco completo (veredito, gráfico, pizza, tabelas). `ref` = resultado do realista, para mostrar a variação. */
function renderBlocoST(p, params, ufs, base, ref) {
  const vence = (r) => (r.pLula > r.pFlavio ? cLula : cFlavio);
  const sub = (l) => calcST(l, params);
  const br = sub(ufs);
  const refBr = ref ? ref.br : null;
  const w = vence(br), perde = w === cLula ? cFlavio : cLula;
  const difVotos = Math.abs(br.lula - br.flavio);
  let comp = '';
  if (refBr) {
    const d = br.pLula - refBr.pLula;
    comp = ` — ${vence(refBr) === w ? `${w.nome} mantém a vitória` : `<b>${w.nome} vira o resultado</b>`} (Lula ${ppf2(d)} vs. realista)`;
  }
  $(`${p === 'st' ? 'st' : 'stc'}-veredito`).innerHTML = br.validos
    ? `<b style="color:${w.cor}">${w.nome} ${fmtPct(w === cLula ? br.pLula : br.pFlavio)}</b> × <b style="color:${perde.cor}">${perde.nome} ${fmtPct(w === cLula ? br.pFlavio : br.pLula)}</b>${comp}; vantagem de ~${fmtInt.format(Math.round(difVotos))} votos.`
    : 'Sem dados.';

  const grupos = [['Brasil', ufs], ...Object.entries(REGIOES).map(([id, r]) => [r.nome, ufs.filter((e) => e.regiao === id)])];
  const regs = grupos.map(([n, l]) => [n, sub(l)]);
  const refRegs = ref ? ref.regs : null;
  const venc = (r) => { const x = vence(r); return r.validos ? `<td><b style="color:${x.cor}">${x.nome}</b></td><td>${fmtInt.format(Math.round(Math.abs(r.lula - r.flavio)))}</td>` : '<td>—</td><td>—</td>'; };
  const dCol = (r, rr) => (rr ? `<td style="color:${r.pLula - rr.pLula >= 0 ? '#16a34a' : '#dc2626'}">${ppf2(r.pLula - rr.pLula)}</td>` : '');
  const cab = `<th style="color:${cLula.cor}">Lula</th><th style="color:${cFlavio.cor}">Flávio</th><th>Vencedor</th><th>Vantagem (votos)</th>${ref ? '<th>Lula vs. realista</th>' : ''}<th>Votos Lula</th><th>Votos Flávio</th>`;
  $(`${p}-regioes`).innerHTML = `<thead><tr><th>Região</th>${cab}</tr></thead><tbody>${regs.map(([n, r], i) =>
    `<tr><td>${n === 'Brasil' ? '<b>Brasil</b>' : n}</td><td>${fmtPct(r.pLula)}</td><td>${fmtPct(r.pFlavio)}</td>${venc(r)}${dCol(r, refRegs?.[i][1])}<td>${fmtInt.format(Math.round(r.lula))}</td><td>${fmtInt.format(Math.round(r.flavio))}</td></tr>`).join('')}</tbody>`;

  const estados = [...state.estados].sort((x, y) => y.eleitorado - x.eleitorado);
  const linhas = estados.map((e) => {
    const r = sub([base(e)]), rr = ref ? ref.sub([base(e)]) : null;
    return `<tr><td>${e.nome}</td><td>${fmtPct(r.pLula, 1)}</td><td>${fmtPct(r.pFlavio, 1)}</td>${venc(r)}${dCol(r, rr)}</tr>`;
  });
  $(`${p}-ufs`).innerHTML = `<thead><tr><th>Estado</th><th style="color:${cLula.cor}">Lula</th><th style="color:${cFlavio.cor}">Flávio</th><th>Vencedor</th><th>Vantagem (votos)</th>${ref ? '<th>Lula vs. realista</th>' : ''}</tr></thead><tbody>${linhas.join('')}</tbody>`;

  const ch = chartsST[p];
  ch.data.labels = regs.map(([n]) => n);
  ch.data.datasets = [
    { label: 'Lula', data: regs.map(([, r]) => r.pLula), backgroundColor: cLula.cor },
    { label: 'Flávio Bolsonaro', data: regs.map(([, r]) => r.pFlavio), backgroundColor: cFlavio.cor },
  ];
  ch.update();
  const total = br.lula + br.flavio + br.sem;
  const itens = [{ n: 'Lula', v: br.lula, c: cLula.cor }, { n: 'Flávio Bolsonaro', v: br.flavio, c: cFlavio.cor }, { n: 'Branco/nulo/indeciso', v: br.sem, c: '#94a3b8' }];
  const pz = pizzas[`pizza-${p}`];
  pz.data.labels = itens.map((x) => x.n); pz.data.datasets[0].data = itens.map((x) => (total ? (x.v / total) * 100 : 0));
  pz.data.datasets[0].backgroundColor = itens.map((x) => x.c); pz.update();
  $(`pizza-${p}-l`).innerHTML = itens.map((x) => `<span style="--c:${x.c}">${x.n} <b>${fmtPct(total ? (x.v / total) * 100 : 0, 1)}</b></span>`).join('');
  return { br, regs, sub };
}

/** Tabela de distribuição: para onde vai cada grupo do 1º turno (percentual e votos). `ref` = taxas do realista, para mostrar a variação. */
function renderDistribuicao(p, params, agg, ref) {
  const nf = (n) => fmtInt.format(Math.round(n));
  const dv = (n, r) => (ref && Math.abs(n - r) >= 0.5 ? ` <span style="color:${n > r ? '#16a34a' : '#dc2626'}">${n > r ? '+' : '−'}${nf(Math.abs(n - r))}</span>` : '');
  const dp = (x, r) => (ref && Math.abs(x - r) >= 0.5 ? ` <span class="muted">(realista ${fmtPct(r, 1)})</span>` : '');
  const totalDe = (g, q) => (g.chave === 'novos' ? ((agg.abstencao || 0) * q.comparecem) / 100 : g.ids.reduce((s, id) => s + (agg.votos[id] || 0), 0));
  const linhas = [
    { nome: 'Eleitores de Lula (repetem o voto)', tot: agg.votos[LULA] || 0, f: 0, l: 100, rf: 0, rl: 100 },
    { nome: 'Eleitores de Flávio (repetem o voto)', tot: agg.votos[FLAVIO] || 0, f: 100, l: 0, rf: 100, rl: 0 },
    ...LINHAS_PARAMS.map((g) => ({ nome: g.chave === 'novos' ? `${g.nome} (${fmtPct(params.novos.comparecem, 0)} das abstenções)` : g.nome, tot: totalDe(g, params[g.chave]),
      f: params[g.chave].f, l: params[g.chave].l, rf: ref ? ref[g.chave].f : params[g.chave].f, rl: ref ? ref[g.chave].l : params[g.chave].l })),
  ];
  const cel = (tot, x, rx) => `<td>${fmtPct(x, 1)}${dp(x, rx)}</td><td>${nf((tot * x) / 100)}${dv((tot * x) / 100, (tot * rx) / 100)}</td>`;
  const tot = linhas.reduce((a, g) => ({ t: a.t + g.tot, f: a.f + (g.tot * g.f) / 100, l: a.l + (g.tot * g.l) / 100, rf: a.rf + (g.tot * g.rf) / 100, rl: a.rl + (g.tot * g.rl) / 100 }), { t: 0, f: 0, l: 0, rf: 0, rl: 0 });
  const sem = tot.t - tot.f - tot.l, rsem = tot.t - tot.rf - tot.rl;
  const corpo = linhas.map((g) => `<tr><td>${g.nome}</td><td>${nf(g.tot)}</td>${cel(g.tot, g.f, g.rf)}${cel(g.tot, g.l, g.rl)}${cel(g.tot, 100 - g.f - g.l, 100 - g.rf - g.rl)}</tr>`).join('');
  const rodape = tot.t ? `<tr><td><b>Total do 2º turno</b></td><td><b>${nf(tot.t)}</b></td>
    <td><b>${fmtPct((tot.f / tot.t) * 100, 1)}</b></td><td><b>${nf(tot.f)}</b>${dv(tot.f, tot.rf)}</td>
    <td><b>${fmtPct((tot.l / tot.t) * 100, 1)}</b></td><td><b>${nf(tot.l)}</b>${dv(tot.l, tot.rl)}</td>
    <td><b>${fmtPct((sem / tot.t) * 100, 1)}</b></td><td><b>${nf(sem)}</b>${dv(sem, rsem)}</td></tr>` : '';
  $(`${p}-dist`).innerHTML = `<thead><tr><th>Origem (1º turno)</th><th>Eleitores</th><th style="color:${cFlavio.cor}">→ Flávio (%)</th><th style="color:${cFlavio.cor}">→ Flávio (votos)</th>
    <th style="color:${cLula.cor}">→ Lula (%)</th><th style="color:${cLula.cor}">→ Lula (votos)</th><th>→ Branco/nulo/indeciso (%)</th><th>→ Branco/nulo/indeciso (votos)</th></tr></thead><tbody>${corpo}</tbody><tfoot>${rodape}</tfoot>`;
}

/** Durante o 1º turno: projeção do 2º a partir da apuração atual (ou da projeção a 100%). */
function renderSegundoTurno() {
  const params = paramsST();
  const base = $('st-base').value === 'hoje' ? (e) => e : projetar;
  const ufs = state.estados.map(base);
  const agg = agg1(ufs);
  preencherParamsST(params, agg);
  // 1) realista
  const real = renderBlocoST('st', params, ufs, base, null);
  // 2) pessimista: parte das taxas do realista e só soma o bônus de Lula
  const bonus = Math.max(0, parseFloat($('stc-pct').value) || 0);
  const pess = aplicarBonus(params, bonus, $('stc-fonte').value);
  renderBlocoST('stc', pess, ufs, base, { br: real.br, regs: real.regs, sub: real.sub });
  renderDistribuicao('st', params, agg, null);
  renderDistribuicao('stc', pess, agg, params);
}

/** Frase "no 1º turno, neste ponto, Lula tinha X%; hoje Y% → swing". */
const cmpLinha = (c) => (c ? `<br>Comparado com o 1º turno no mesmo ponto da apuração (estado a estado, votos convertidos para o 2º turno): Lula tinha <b>${fmtPct(c.s1)}</b>, hoje tem <b>${fmtPct(c.hoje)}</b> → swing de <b style="color:${c.swing >= 0 ? '#16a34a' : '#dc2626'}">${ppf2(c.swing)}</b>${c.extrapolado > 0.5 ? ' <span class="muted">(maioria dos votos de estados abaixo do primeiro ponto gravado no 1º turno: comparação aproximada)</span>' : ''}.` : '');
/** Células "Lula no 1º turno neste ponto" e "swing" de uma lista de estados. */
const cmpCels = (lista) => {
  const c = comparar1T(lista, CAL);
  if (!c) return '<td>—</td><td>—</td>';
  const it = c.extrapolado > 0.5;
  return `<td>${it ? '<i>' : ''}${fmtPct(c.s1, 1)}${it ? '</i>' : ''}</td><td style="color:${c.swing >= 0 ? '#16a34a' : '#dc2626'}">${it ? '<i>' : ''}${ppf2(c.swing)}${it ? '</i>' : ''}</td>`;
};

/** Durante o 2º turno: prévia (1º turno final + pesquisas) × estimativa com a apuração, por região e estado. */
function renderPrevia() {
  if (!CAL?.previa) return;
  const params = normalizar(CAL.params);
  preencherParamsST(params, { votos: CAL.previa.br.votos1, abstencao: CAL.previa.br.abstencao1 });
  const br = agregar(state.estados), pv = CAL.previa.br, est = estimar(state.estados, CAL);
  const d = est.pct[LULA] - pv.pLula;
  const vLinha = (p) => `<b style="color:${cLula.cor}">Lula ${fmtPct(p.pLula)}</b> × <b style="color:${cFlavio.cor}">Flávio ${fmtPct(p.pFlavio)}</b>`;
  $('pv-veredito').innerHTML = `Prévia, antes de qualquer urna: ${vLinha(pv)} <span class="muted">(${fmtInt.format(Math.round(pv.validos))} votos válidos esperados, ${fmtInt.format(Math.round(pv.novos))} de quem não votou no 1º turno)</span>.<br>
    ${br.validos ? `Estimativa agora, com ${fmtPct(br.apuracao, 1)} apurado: ${vLinha({ pLula: est.pct[LULA], pFlavio: est.pct[FLAVIO] })} — Lula <b style="color:${d >= 0 ? '#16a34a' : '#dc2626'}">${ppf2(d)}</b> em relação à prévia.${cmpLinha(comparar1T(state.estados, CAL))}` : 'Ainda sem urnas apuradas: a estimativa é a própria prévia.'}`;
  renderDistribuicao('pv', params, { votos: CAL.previa.br.votos1, abstencao: CAL.previa.br.abstencao1 }, null);

  const linha = (nome, lista, a) => {
    const p = previaDe(lista, CAL), e = estimar(lista, CAL), h = agregar(lista);
    const dl = e.pct[LULA] - p.pLula, v = e.pct[LULA] > e.pct[FLAVIO] ? cLula : cFlavio, pvw = p.pLula > p.pFlavio ? cLula : cFlavio;
    const peso = a?.tipo === 'uf' ? `<td>${fmtPct(h.validos ? pesoApuracao(lista[0]) * 100 : 0, 0)}</td>` : '';
    return `<tr${a ? ` data-tipo="${a.tipo}" data-id="${a.id}"` : ''}><td>${nome}</td><td>${fmtPct(h.apuracao, 1)}</td>${peso}
      <td>${fmtPct(p.pLula, 1)}</td><td>${fmtPct(p.pFlavio, 1)}</td>
      <td>${h.validos ? fmtPct(h.pct[LULA], 1) : '—'}</td>${cmpCels(lista)}
      <td><b>${fmtPct(e.pct[LULA], 1)}</b></td><td><b>${fmtPct(e.pct[FLAVIO], 1)}</b></td>
      <td style="color:${dl >= 0 ? '#16a34a' : '#dc2626'}">${h.validos ? ppf2(dl) : '—'}</td>
      <td><b style="color:${v.cor}">${v.nome}</b>${v !== pvw ? ' <span class="aviso">≠ prévia</span>' : ''}</td></tr>`;
  };
  const cab = (peso) => `<thead><tr><th>${peso ? 'Estado' : 'Região'}</th><th>Apurado</th>${peso ? '<th>Peso da apuração</th>' : ''}<th style="color:${cLula.cor}">Prévia Lula</th><th style="color:${cFlavio.cor}">Prévia Flávio</th>
    <th style="color:${cLula.cor}">Lula hoje</th><th>Lula no 1º turno neste ponto</th><th>Swing vs. 1º turno</th><th style="color:${cLula.cor}">Estimativa Lula</th><th style="color:${cFlavio.cor}">Estimativa Flávio</th><th>Lula vs. prévia</th><th>Vencedor estimado</th></tr></thead>`;
  $('pv-regioes').innerHTML = `${cab(false)}<tbody>${[['Brasil', state.estados, null], ...Object.entries(REGIOES).map(([id, r]) => [r.nome, state.estados.filter((e) => e.regiao === id), { tipo: 'regiao', id }])].map(([n, l, a]) => linha(n === 'Brasil' ? '<b>Brasil</b>' : n, l, a)).join('')}</tbody>`;
  const estados = [...state.estados].sort((x, y) => y.eleitorado - x.eleitorado);
  $('pv-ufs').innerHTML = `${cab(true)}<tbody>${estados.map((e) => linha(e.nome, [e], { tipo: 'uf', id: e.uf })).join('')}</tbody>`;
}

function renderProjecao() {
  const lista = doEscopo(state.escopo);
  const atual = agregar(lista);
  const simples = agregar(lista.map(projetar));
  const cal = CAL ? estimar(lista, CAL) : null; // 2º turno: calibrada pelos erros medidos no 1º + prévia das pesquisas
  const previa = previaDe(lista, CAL);
  const proj = cal ?? simples;
  const semDados = lista.filter((e) => e.apuracao === 0).length;
  $('proj-titulo').textContent = `${cal ? 'Estimativa' : 'Projeção'} · ${nomeEscopo(state.escopo)} com 100% apurado${cal ? ' · 1º turno + pesquisas + apuração' : ''}`;
  const ord = [...CANDIDATOS].sort((x, y) => proj.pct[y.id] - proj.pct[x.id]).slice(0, TURNO.turno === 2 ? 2 : 6);
  const l = proj.ranking[0], s2 = proj.ranking[1];
  const veredito = !proj.validos ? 'Sem votos apurados ainda.'
    : TURNO.turno === 2 ? `<b style="color:${l.cor}">${l.nome}</b> venceria com ${fmtPct(proj.pct[l.id])} dos válidos × <b style="color:${s2.cor}">${s2.nome}</b> ${fmtPct(proj.pct[s2.id])}${atual.validos ? '' : ' <span class="muted">(prévia: ainda sem urnas apuradas)'}.`
    : proj.pct[l.id] > 50 ? `<b style="color:${l.cor}">${l.nome}</b> venceria no 1º turno (${fmtPct(proj.pct[l.id])} dos válidos).`
    : `Iria a <b>2º turno</b>: <b style="color:${l.cor}">${l.nome}</b> ${fmtPct(proj.pct[l.id])} × <b style="color:${s2.cor}">${s2.nome}</b> ${fmtPct(proj.pct[s2.id])}.`;
  const sl = simples.ranking[0];
  const nota = (cal && simples.validos ? ` Projeção simples (sem calibração nem prévia): ${sl.nome} ${fmtPct(simples.pct[sl.id])}.` : '')
    + (previa ? ` Prévia (1º turno + pesquisas): ${previa.pLula > previa.pFlavio ? `Lula ${fmtPct(previa.pLula)}` : `Flávio ${fmtPct(previa.pFlavio)}`}.` : '');
  $('proj-veredito').innerHTML = `${veredito}<br><span class="muted">${atual.validos ? `Hoje (${fmtPct(atual.apuracao, 1)} apurado): ${fmtPct(atual.pct[atual.ranking[0].id])} ${atual.ranking[0].nome}.` : 'Sem votos apurados ainda.'}${nota}${semDados ? ` ${semDados} UF(s) sem votos ainda${previa ? ' entram só com a prévia' : ' ficaram fora'}.` : ''}</span>`;
  const pp = (d) => `${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.`;
  const pvPct = (c) => (previa ? (c.id === LULA ? previa.pLula : c.id === FLAVIO ? previa.pFlavio : 0) : 0);
  $('proj-cands').innerHTML = `<thead><tr><th>Candidato</th><th>Hoje</th>${cal ? '<th>Projeção simples</th><th>Prévia (1º turno + pesquisas)</th><th>Estimativa</th>' : '<th>Projetado</th>'}<th>Variação vs. hoje</th><th>Votos ${cal ? 'estimados' : 'projetados'}</th></tr></thead><tbody>${ord.map((c) => {
    const d = proj.pct[c.id] - atual.pct[c.id];
    return `<tr><td><span style="color:${c.cor}">●</span> ${c.nome}</td><td>${atual.validos ? fmtPct(atual.pct[c.id]) : '—'}</td>
      ${cal ? `<td>${simples.validos ? fmtPct(simples.pct[c.id]) : '—'}</td><td>${fmtPct(pvPct(c))}</td>` : ''}<td><b>${fmtPct(proj.pct[c.id])}</b></td><td style="color:${d >= 0 ? '#16a34a' : '#dc2626'}">${atual.validos ? pp(d) : '—'}</td>
      <td>${fmtInt.format(proj.votos[c.id])}</td></tr>`; }).join('')}</tbody>`;
  const regs = Object.entries(REGIOES).map(([id, r]) => {
    const l2 = state.estados.filter((e) => e.regiao === id);
    return { r, a: agregar(l2), p: CAL ? estimar(l2, CAL) : agregar(l2.map(projetar)) };
  });
  $('proj-regioes').innerHTML = `<thead><tr><th>Região</th><th>Apurado</th><th>Líder hoje</th><th>Líder ${CAL ? 'estimado' : 'projetado'}</th><th>Eleitores</th></tr></thead><tbody>${regs.map(({ r, a, p }) => `
    <tr><td>${r.nome}</td><td>${fmtPct(a.apuracao, 1)}</td>
    <td>${a.validos ? `<span style="color:${a.lider.cor}">${a.lider.nome}</span> ${fmtPct(a.pct[a.lider.id], 1)}` : '—'}</td>
    <td>${p.validos ? `<b style="color:${p.lider.cor}">${p.lider.nome}</b> ${fmtPct(p.pct[p.lider.id], 1)}` : '—'}</td>
    <td>${fmtInt.format(a.eleitorado)}</td></tr>`).join('')}</tbody>`;
}

function renderTopo() {
  $('modo').textContent = state.erro ? 'ERRO NA LEITURA' : 'AO VIVO · TSE';
  $('modo').className = `badge ${state.erro ? 'sim' : 'live'}`;
  $('atualizado').textContent = state.erro ? state.erro : state.atualizado ? `Arquivo TSE de ${state.atualizado}` : 'Carregando…';
  $('rodape').textContent = `Fonte: resultados.tse.jus.br (${TURNO.turno}º turno 2026, Presidente).${CAL ? ' Estimativa: prévia do 1º turno + pesquisas de transferência de voto, corrigida pelos erros de projeção medidos no 1º turno (ver Histórico).' : ''} Atualiza a cada 30 s. Percentuais sobre votos válidos; % de apuração = seções totalizadas ÷ total de seções.`;
}

function render() {
  renderTopo(); renderPlacar(); renderKpis(); renderEscopo(); renderRegioes(); renderDetalhe(); renderComparativo(); renderProjecao(); renderCenario();
  if (TURNO.turno === 1) renderSegundoTurno(); else renderPrevia(); // 1º turno: projeção do 2º · 2º turno: prévia × estimativa
  renderPizzas(); renderTabela(); renderFoco();
}

// ---------- placar nacional (independente da altura de cada município) ----------
function renderPlacar() {
  const br = agregar(state.estados);
  const lado = (c, cls) => `<div class="cand ${cls}" style="--c:${c.cor}">
      <div class="cand-n"><span class="cand-num">${c.numero}</span><b>${c.nome}</b><small>${c.partido}</small></div>
      <div class="cand-p">${fmtPct(br.pct[c.id], 1)}</div>
      <div class="cand-v">${fmtInt.format(br.votos[c.id])} votos</div>
      <div class="cand-b"><i style="width:${br.pct[c.id]}%"></i></div>
    </div>`;
  const r = 26, circ = 2 * Math.PI * r;
  $('placar').innerHTML = `${lado(cFlavio, 'esq')}
    <div class="nacional">
      <div class="nac-l">Votos válidos apurados</div>
      <div class="nac-v">${fmtInt.format(br.validos)}</div>
      <div class="nac-a">
        <div><div class="nac-l">Apuração nacional</div><div class="nac-p">${fmtPct(br.apuracao, 1)}</div></div>
        <svg viewBox="0 0 64 64" class="anel"><circle cx="32" cy="32" r="${r}"/><circle class="v" cx="32" cy="32" r="${r}" stroke-dasharray="${(br.apuracao / 100) * circ} ${circ}"/></svg>
      </div>
      ${projNac(br)}
      <p>Totais nacionais (todas as seções do país). Não dependem da altura de cada município no mapa.</p>
    </div>
    ${lado(cLula, 'dir')}`;
}

/** 2º turno: estimativa do resultado final (prévia do 1º turno + pesquisas, corrigida pela apuração e pelas curvas do 1º turno). */
function projNac(br) {
  if (!CAL || br.apuracao >= 99.99) return '';
  const p = estimar(state.estados, CAL), s = agregar(state.estados.map(projetar));
  const l = p.ranking[0], o = p.ranking[1];
  return `<div class="nac-proj"><div class="nac-l">Estimativa final · 1º turno + pesquisas + apuração</div>
    <b style="color:${l.cor}">${l.nome} ${fmtPct(p.pct[l.id], 1)}</b> × <b style="color:${o.cor}">${o.nome} ${fmtPct(p.pct[o.id], 1)}</b>
    <small>${br.validos ? `projeção simples: ${s.ranking[0].nome} ${fmtPct(s.pct[s.ranking[0].id], 1)}` : 'ainda sem urnas: é a prévia (1º turno + pesquisas)'}</small></div>`;
}

// ---------- mapa 3D por município ----------
const CIDADES = [ // código IBGE, lado da chamada
  ['1302603', 'e'], ['5300108', 'e'], ['3550308', 'e'],
  ['2611606', 'd'], ['2927408', 'd'], ['3106200', 'd'], ['3304557', 'd'],
];
const FAIXAS = [[0, 10], [10, 30], [30, 50], [50, 70], [70, 90], [90, 100]];
const faixaDe = (p) => FAIXAS.findIndex(([, b], i) => p < b || i === FAIXAS.length - 1);
let mapa = null;
const porIbge = new Map();
const liderMuni = (m) => { const a = agregar([m]); return { a, l: a.validos ? a.lider : null }; };

/** Prisma isométrico em SVG (legendas). */
function prisma(cx, base, larg, alt, cor, sombra = 0.62) {
  const c = new Color(cor), dx = larg / 2, dy = larg / 4;
  const topo = `${cx},${base - alt - 2 * dy} ${cx + dx},${base - alt - dy} ${cx},${base - alt} ${cx - dx},${base - alt - dy}`;
  return `<polygon points="${cx - dx},${base - alt - dy} ${cx},${base - alt} ${cx},${base} ${cx - dx},${base - dy}" fill="${c.mul(0.78)}"/>
    <polygon points="${cx + dx},${base - alt - dy} ${cx},${base - alt} ${cx},${base} ${cx + dx},${base - dy}" fill="${c.mul(sombra)}"/>
    <polygon points="${topo}" fill="${c.mul(1.08)}"/>
    <polyline points="${cx - dx},${base - alt - dy} ${cx},${base - alt} ${cx + dx},${base - alt - dy}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width=".8"/>`;
}
class Color {
  constructor(hex) { const n = parseInt(hex.slice(1), 16); this.r = n >> 16; this.g = (n >> 8) & 255; this.b = n & 255; }
  mul(k) { const f = (v) => Math.min(255, Math.round(v * k)); return `rgb(${f(this.r)},${f(this.g)},${f(this.b)})`; }
}

function renderLegendas() {
  const ms = state.munis;
  const nFaixa = FAIXAS.map(() => 0), nLider = new Map();
  for (const m of ms) {
    nFaixa[faixaDe(m.apuracao)]++;
    const { l } = liderMuni(m);
    if (l) nLider.set(l.id, (nLider.get(l.id) || 0) + 1);
  }
  const NEUTRO = '#6f86b8';
  const escala = 92 / ALT_MAX;
  $('leg-alt').innerHTML = `<svg viewBox="0 0 360 150" role="img" aria-label="Altura do bloco conforme o percentual apurado">${FAIXAS.map(([a, b], i) =>
    prisma(32 + i * 59, 118, 38, alturaDe((a + b) / 2) * escala, NEUTRO)).join('')}</svg>
    <div class="degraus-l">${FAIXAS.map(([a, b], i) => `<span><b>${a}–${b}%</b>${ms.length ? `<small>${fmtInt.format(nFaixa[i])} mun.</small>` : ''}</span>`).join('')}</div>`;

  const ordem = [cFlavio, cLula, ...CANDIDATOS.filter((c) => c !== cFlavio && c !== cLula && nLider.get(c.id))];
  $('leg-cor').innerHTML = ordem.map((c, i) => `<div class="lider ${i > 1 ? 'outro' : ''}">
      <svg viewBox="0 0 80 84" aria-hidden="true">${prisma(40, 76, i > 1 ? 36 : 56, i > 1 ? 22 : 36, c.cor)}</svg>
      <div><span class="eq" style="color:${c.cor}">${c.nome}</span>
      ${ms.length ? `<small>lidera em <b>${fmtInt.format(nLider.get(c.id) || 0)}</b> municípios</small>` : ''}</div></div>`).join('');

  // ilustração "como ler": mesma cor com alturas diferentes, mesma altura com cores diferentes
  const B = cFlavio.cor, R = cLula.cor;
  const blocos = [[B, 12], [B, 34], [B, 62], [R, 62], [R, 30], [R, 8]];
  $('leg-como').innerHTML = `<svg viewBox="0 0 170 120" aria-hidden="true">${blocos.map(([c, h], i) => prisma(22 + i * 25, 104 - (i % 2) * 6, 24, h, c)).join('')}</svg>
    <dl>
      <dt><i class="sw" style="background:${B}"></i><i class="sw" style="background:${R}"></i> Cor</dt><dd>candidato que está na frente <em>no município</em></dd>
      <dt><svg class="mini-alt" viewBox="0 0 30 16" aria-hidden="true"><rect x="1" y="11" width="6" height="4"/><rect x="9" y="7" width="6" height="8"/><rect x="17" y="3" width="6" height="12"/><rect x="25" y="0" width="4" height="15"/></svg> Altura</dt><dd>percentual de seções já apuradas <em>no município</em></dd>
    </dl>`;
}

function chamadaHtml(m) {
  const { a, l } = liderMuni(m);
  const doUf = state.munis.filter((x) => x.uf === m.uf);
  const altos = doUf.filter((x) => x.apuracao >= 90).length;
  return `<b class="ch-n">${m.nome}</b>
    <span class="ch-l" style="color:${l ? l.cor : 'inherit'}">${l ? `${l.nome} · ${fmtPct(a.pct[l.id], 1)}` : 'Sem votos apurados'}</span>
    <div class="ch-a"><span>Apurado no município</span><b>${fmtPct(m.apuracao, 1)}</b></div>
    <div class="ch-b"><i style="width:${m.apuracao}%"></i></div>
    <small>${m.uf}: ${fmtInt.format(altos)} de ${fmtInt.format(doUf.length)} municípios com 90%+ apurado</small>`;
}

function renderMapa3D() {
  if (!mapa || !state.munis.length) return;
  const noMapa = state.munis.filter((m) => mapa.tem(m.ibge)).length, fora = state.munis.length - noMapa;
  $('mapa-status').textContent = `${fmtInt.format(noMapa)} municípios · cada bloco é um município${fora ? ` (${fora} sem malha no IBGE)` : ''}`;
  const dados = new Map();
  for (const m of state.munis) {
    const { l } = liderMuni(m);
    dados.set(m.ibge, { cor: l?.cor, apuracao: m.apuracao });
  }
  mapa.atualizar(dados);
  // chamadas das capitais só na visão Brasil; dentro de um estado, quem fala é o painel lateral
  mapa.destaques(state.foco ? [] : CIDADES.map(([ibge, lado]) => porIbge.get(ibge) && { ibge, lado, html: chamadaHtml(porIbge.get(ibge)) }).filter(Boolean));
}

function mostrarTip(ibge, x, y) {
  const tip = $('tip'), m = ibge && porIbge.get(ibge);
  if (!m) { tip.classList.remove('on'); return; }
  const { a, l } = liderMuni(m);
  const top = a.ranking.slice(0, 3).filter((c) => a.votos[c.id]);
  tip.innerHTML = `<b>${m.nome} <span>${m.uf}</span></b>
    <div class="tip-a"><span>Apurado</span><b>${fmtPct(m.apuracao, 1)}</b></div><div class="ch-b"><i style="width:${m.apuracao}%"></i></div>
    ${l ? top.map((c) => `<div class="tip-c"><i style="background:${c.cor}"></i>${c.nome}<b>${fmtPct(a.pct[c.id], 1)}</b></div>`).join('') : '<div class="muted">Sem votos apurados</div>'}
    <small>${fmtInt.format(m.eleitorado)} eleitores · ${fmtInt.format(m.secoes.apuradas)}/${fmtInt.format(m.secoes.total)} seções</small>`;
  const r = tip.parentElement.getBoundingClientRect();
  const tx = Math.min(x - r.left + 16, r.width - tip.offsetWidth - 8), ty = Math.max(8, y - r.top - tip.offsetHeight - 14);
  tip.style.transform = `translate(${tx}px, ${ty}px)`;
  tip.classList.add('on');
}

// ---------- foco: estado → cidade ----------
// Clique numa cidade: voa até o estado dela (se preciso), borda na cidade e painel com os dados da cidade.
// Clique de novo na mesma cidade (ou no botão com o nome do estado, sobre o mapa): sai da cidade e o painel mostra o estado.
// A borda sai ao clicar em outra cidade (que ganha a borda), ao selecionar o estado ou ao voltar ao Brasil.
const ppf = (d) => `${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
const regiaoDe = (uf) => ESTADOS.find((e) => e.uf === uf)?.regiao;
const nomeUf = (uf) => ESTADOS.find((e) => e.uf === uf)?.nome ?? uf;
const larguraFoco = () => (matchMedia('(max-width: 900px)').matches ? 0 : ($('foco').offsetWidth || 372) + 28);
// totais oficiais por estado (arquivo do TSE); sem eles, soma dos municípios
const unidadesUf = (uf) => (state.estados.length ? state.estados.filter((e) => e.uf === uf) : state.munis.filter((m) => m.uf === uf));
const unidadesRegiao = (r) => (state.estados.length ? state.estados.filter((e) => e.regiao === r) : state.munis.filter((m) => regiaoDe(m.uf) === r));
const unidadesBrasil = () => (state.estados.length ? state.estados.filter((e) => e.uf !== 'ZZ') : state.munis);

function clicarMunicipio(ibge) {
  const m = porIbge.get(ibge);
  if (!m || !mapa) return;
  if (!state.foco || state.foco.uf !== m.uf) { // vindo do Brasil (ou de outro estado): voa até o estado
    state.foco = { uf: m.uf, cidade: ibge };
    $('foco').hidden = false; // antes do voo: a câmera desconta a largura do painel
    renderFoco();
    mapa.focar(ibge, { destacar: true, nomeEstado: nomeUf(m.uf) });
    state.escopo = { tipo: 'uf', id: m.uf };
    render(); renderMapa3D();
    return;
  }
  if (state.foco.cidade === ibge) { selecionarEstado(); return; } // 2º clique na mesma cidade: desseleciona
  state.foco.cidade = ibge;
  mapa.destacar(ibge);
  renderFoco();
}
function selecionarEstado() {
  if (!state.foco) return;
  state.foco.cidade = null;
  mapa?.destacar(null);
  renderFoco();
}
function voltarBrasil() {
  if (!state.foco) return;
  state.foco = null;
  mapa?.brasil();
  state.escopo = { tipo: 'br', id: 'BR' };
  render(); renderMapa3D(); renderFoco();
}

/** Barras comparando o % de cada candidato entre níveis (o 1º nível é o foco; os demais mostram a diferença). */
function comparativo(niveis, cands) {
  const [eu] = niveis;
  return `<div class="cmp-tab">${cands.map((c) => `<div class="cmp">
    <div class="cmp-h"><i style="background:${c.cor}"></i>${c.nome}</div>
    ${niveis.map((n, i) => {
      const v = n.a.validos ? n.a.pct[c.id] : 0, d = eu.a.pct[c.id] - n.a.pct[c.id];
      return `<div class="cmp-r ${i ? '' : 'eu'}"><span>${n.nome}</span><div class="cmp-b"><i style="width:${v}%;background:${c.cor}"></i><u></u></div>
        <b>${n.a.validos ? fmtPct(v, 1) : '—'}</b><small class="${d > 0.05 ? 'mais' : d < -0.05 ? 'menos' : ''}">${i && n.a.validos && eu.a.validos ? ppf(d) : ''}</small></div>`;
    }).join('')}</div>`).join('')}
    <p class="cmp-nota">p.p. = diferença de <b>${eu.nome}</b> em relação a cada nível · traço = 50%</p></div>`;
}
const candsDe = (a) => a.ranking.filter((c) => a.votos[c.id] > 0).slice(0, TURNO.turno === 2 ? 2 : 3);
const kpi = (l, v, s = '') => `<div class="fk"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`;
const barraApur = (p) => `<div class="ch-b"><i style="width:${p}%"></i></div>`;

function renderFoco() {
  const el = $('foco');
  $('btn-brasil').hidden = !state.foco;
  document.querySelector('.palco').classList.toggle('em-foco', !!state.foco);
  if (!state.foco) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const { uf, cidade } = state.foco;
  const reg = regiaoDe(uf), nomeReg = REGIOES[reg].nome;
  const estUni = unidadesUf(uf), est = agregar(estUni), br = agregar(unidadesBrasil());
  const munisUf = state.munis.filter((m) => m.uf === uf);
  const trilha = `<nav class="trilha"><button data-foco="brasil">Brasil</button><i>›</i>${cidade
    ? `<button data-foco="estado">${nomeUf(uf)}</button><i>›</i><span>${porIbge.get(cidade).nome}</span>` : `<span>${nomeUf(uf)}</span>`}</nav>`;

  if (!cidade) {
    const ra = agregar(unidadesRegiao(reg));
    const l = est.validos ? est.lider : null, seg = est.ranking[1];
    const lid = new Map();
    for (const m of munisUf) { const { l: x } = liderMuni(m); if (x) lid.set(x.id, (lid.get(x.id) || 0) + 1); }
    const nLid = [...lid.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ c: cand[id], n }));
    const altos = munisUf.filter((m) => m.apuracao >= 90).length;
    const maiores = [...munisUf].sort((a, b) => b.eleitorado - a.eleitorado).slice(0, 8);
    const proj = est.apuracao < 99.99 && (est.validos || CAL) ? (CAL ? estimar(estUni, CAL) : agregar(estUni.map(projetar))) : null;
    el.innerHTML = `${trilha}
      <h3>${nomeUf(uf)} <small>${nomeReg}</small></h3>
      ${l ? `<p class="flider"><b style="color:${l.cor}">${l.nome}</b> lidera com ${fmtPct(est.pct[l.id], 1)} · ${ppf(est.pct[l.id] - est.pct[seg.id]).replace('+', '')} à frente de ${seg.nome}</p>` : '<p class="flider">Sem votos apurados ainda.</p>'}
      <div class="fks">
        ${kpi('Apurado', fmtPct(est.apuracao, 1), barraApur(est.apuracao))}
        ${kpi('Eleitorado', fmtInt.format(est.eleitorado), `${fmtPct((est.eleitorado / br.eleitorado) * 100, 1)} do Brasil`)}
        ${kpi('Votos válidos', fmtInt.format(est.validos))}
        ${kpi('Municípios', fmtInt.format(munisUf.length), `${fmtInt.format(altos)} com 90%+ apurado`)}
      </div>
      ${proj ? `<p class="fproj">${CAL ? 'Estimativa final (1º turno + pesquisas + apuração)' : 'Projeção com 100% apurado'}: <b style="color:${proj.lider.cor}">${proj.lider.nome} ${fmtPct(proj.pct[proj.lider.id], 1)}</b>${CAL && est.validos && est.apuracao < APURACAO_PLENA ? ` <span class="muted">· prévia pesa ${fmtPct((1 - pesoApuracao(estUni[0])) * 100, 0)}</span>` : ''}${(() => { const c = CAL && est.validos ? comparar1T(estUni, CAL) : null; return c ? `<br><span class="muted">No 1º turno, neste ponto, Lula tinha ${fmtPct(c.s1, 1)}; hoje ${fmtPct(c.hoje, 1)} → swing ${ppf(c.swing)}</span>` : ''; })()}</p>` : ''}
      <h4>Comparação · ${nomeUf(uf)} × ${nomeReg} × Brasil</h4>
      ${comparativo([{ nome: uf, a: est }, { nome: nomeReg, a: ra }, { nome: 'Brasil', a: br }], candsDe(est))}
      ${nLid.length ? `<h4>Quem lidera nos municípios</h4>
        <div class="pilha">${nLid.map(({ c, n }) => `<i style="width:${(n / munisUf.length) * 100}%;background:${c.cor}" title="${c.nome}: ${n}"></i>`).join('')}</div>
        <p class="fleg">${nLid.map(({ c, n }) => `<span><i style="background:${c.cor}"></i>${c.nome} <b>${fmtInt.format(n)}</b></span>`).join('')}</p>` : ''}
      <h4>Maiores municípios</h4>
      <ul class="fmunis">${maiores.map((m) => { const { a, l: x } = liderMuni(m); return `<li><button data-cidade="${m.ibge}">
        <span>${m.nome}</span>
        <b style="color:${x ? x.cor : 'inherit'}">${x ? `${x.nome.split(' ')[0]} ${fmtPct(a.pct[x.id], 1)}` : '—'}</b>
        <small>${fmtPct(m.apuracao, 0)} apurado</small></button></li>`; }).join('')}</ul>
      <p class="fdica">Clique em qualquer município de ${nomeUf(uf)} no mapa para ver os dados dele.</p>`;
    return;
  }

  // ----- cidade -----
  const m = porIbge.get(cidade);
  const { a } = liderMuni(m);
  const resto = agregar(munisUf.filter((x) => x.ibge !== cidade));
  const l = a.validos ? a.lider : null, seg = a.ranking[1];
  const porEleit = [...munisUf].sort((x, y) => y.eleitorado - x.eleitorado);
  const posEleit = porEleit.findIndex((x) => x.ibge === cidade) + 1;
  const estMun = agregar(munisUf);
  const peso = estMun.validos ? (a.validos / estMun.validos) * 100 : 0;
  let posLider = 0;
  if (l) {
    const ord = munisUf.map((x) => ({ x, p: agregar([x]).pct[l.id] || 0 })).sort((p, q) => q.p - p.p);
    posLider = ord.findIndex((o) => o.x.ibge === cidade) + 1;
  }
  const todos = a.ranking.filter((c) => a.votos[c.id] > 0).slice(0, 5);
  el.innerHTML = `${trilha}
    <h3>${m.nome} <small>${m.uf}${m.capital ? ' · capital' : ''}</small></h3>
    ${l ? `<p class="flider"><b style="color:${l.cor}">${l.nome}</b> lidera com ${fmtPct(a.pct[l.id], 1)} · ${ppf(a.pct[l.id] - a.pct[seg.id]).replace('+', '')} à frente de ${seg.nome}</p>` : '<p class="flider">Sem votos apurados ainda.</p>'}
    <div class="fks">
      ${kpi('Apurado', fmtPct(m.apuracao, 1), barraApur(m.apuracao))}
      ${kpi('Seções', `${fmtInt.format(m.secoes.apuradas)} / ${fmtInt.format(m.secoes.total)}`)}
      ${kpi('Eleitorado', fmtInt.format(m.eleitorado), `${posEleit}º maior de ${m.uf} (de ${munisUf.length})`)}
      ${kpi('Votos válidos', fmtInt.format(a.validos), `${fmtPct(peso, 1)} dos válidos de ${m.uf}`)}
    </div>
    ${todos.length ? `<h4>Resultado no município</h4><ul class="fres">${todos.map((c) => `<li><i style="background:${c.cor}"></i><span>${c.nome}</span>
      <div class="cmp-b"><i style="width:${a.pct[c.id]}%;background:${c.cor}"></i></div><b>${fmtPct(a.pct[c.id], 1)}</b><small>${fmtInt.format(a.votos[c.id])}</small></li>`).join('')}</ul>` : ''}
    <h4>Comparação · ${m.nome} × resto de ${m.uf} × Brasil</h4>
    ${comparativo([{ nome: m.nome, a }, { nome: `Resto de ${m.uf}`, a: resto }, { nome: 'Brasil', a: br }], candsDe(a.validos ? a : est))}
    ${l ? `<p class="fdica">${l.nome} teve aqui o <b>${posLider}º</b> melhor resultado entre os ${munisUf.length} municípios de ${m.uf}.</p>` : ''}
    <p class="fdica">Clique de novo em ${m.nome} no mapa, ou no nome do estado, para ver ${nomeUf(uf)} inteiro.</p>
    <div class="facoes"><button class="btn" data-foco="estado">Ver ${nomeUf(uf)}</button><button class="btn" data-foco="brasil">← Brasil</button></div>`;
}

document.addEventListener('click', (ev) => {
  const f = ev.target.closest('[data-foco]');
  if (f) { (f.dataset.foco === 'brasil' ? voltarBrasil : selecionarEstado)(); return; }
  const c = ev.target.closest('[data-cidade]');
  if (c) clicarMunicipio(c.dataset.cidade);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !state.foco) return;
  if (state.foco.cidade) selecionarEstado(); else voltarBrasil();
});

async function iniciarMapa() {
  try {
    mapa = await criarMapa3D($('mapa3d'), {
      geoUrl: '/geo/municipios.json',
      bussola: $('bussola'),
      aoPassar: mostrarTip,
      aoClicar: clicarMunicipio,
      aoClicarEstado: selecionarEstado,
      reservaDireita: larguraFoco,
    });
    renderMapa3D();
  } catch (err) {
    console.error(err);
    $('mapa-status').textContent = `Não foi possível iniciar o mapa 3D (${err.message}).`;
  }
}

async function atualizarMunicipios() {
  try {
    const j = await (await fetch('/api/municipios', { cache: 'no-store' })).json();
    const st = $('mapa-status');
    if (!j.municipios.length) {
      st.textContent = j.progresso ? `Lendo municípios no TSE… ${fmtInt.format(j.progresso.feitos)} de ${fmtInt.format(j.progresso.total)}` : 'Lendo municípios no TSE…';
      setTimeout(atualizarMunicipios, 3000);
      return;
    }
    st.classList.add('ok');
    if (j.lidoEm === state.munisLidoEm) return;
    state.munisLidoEm = j.lidoEm;
    state.munis = j.municipios.map(([cd, uf, ibge, nome, capital, eleitorado, eleitoradoApurado, ts, sa, v]) => ({
      cd, uf, ibge, nome, capital: !!capital, eleitorado, eleitoradoApurado, secoes: { total: ts, apuradas: sa },
      apuracao: ts ? (sa / ts) * 100 : 0, votos: Object.fromEntries(j.candidatos.map((id, i) => [id, v[i]])),
    }));
    porIbge.clear();
    for (const m of state.munis) porIbge.set(m.ibge, m);
    renderLegendas();
    renderMapa3D();
    renderFoco();
  } catch (err) {
    console.error(err);
    $('mapa-status').textContent = `Falha ao ler municípios: ${err.message}`;
  }
}

// ---------- dados ----------
async function atualizar() {
  try {
    const t = await fetch('/api/turno', { cache: 'no-store' }).then((x) => x.json()).catch(() => TURNO);
    if (t.turno !== TURNO.turno) { location.reload(); return; } // começou o 2º turno
    const r = await carregarTSE('/tse', TURNO.eleicao);
    state.estados = r.estados;
    state.atualizado = r.atualizadoTSE;
    state.erro = null;
    render();
  } catch (err) {
    console.error(err);
    state.erro = `Falha ao ler o TSE: ${err.message}`;
    renderTopo();
  }
}

// ---------- eventos ----------
document.addEventListener('click', (ev) => {
  const alvo = ev.target.closest('[data-tipo]');
  if (alvo) {
    const { tipo, id } = alvo.dataset;
    state.escopo = tipo === 'br' ? { tipo: 'br', id: 'BR' } : { tipo, id };
    render();
    return;
  }
  const th = ev.target.closest('th[data-k]');
  if (th) {
    const k = th.dataset.k;
    state.ordem = { chave: k, dir: state.ordem.chave === k ? -state.ordem.dir : (k === 'uf' ? 1 : -1) };
    renderTabela();
  }
});
$('btn-atualizar').addEventListener('click', atualizar);
for (const id of ['cen-pp', 'cen-rel']) $(id).addEventListener('input', () => state.estados.length && renderCenario());

$('turno-rotulo').textContent = `${TURNO.turno}º turno`;
$('st-turno1').hidden = TURNO.turno === 2;
$('st-turno2').hidden = TURNO.turno !== 2;
if (TURNO.turno === 2) {
  $('st-titulo').textContent = 'Estimativa do 2º turno · prévia (1º turno + pesquisas) × apuração';
  $('st-intro').innerHTML = `<b>Prévia:</b> o resultado final do 1º turno de cada estado, com os eleitores de Lula e Flávio repetindo o voto, a terceira via dividida pelas taxas abaixo e parte de quem não votou no 1º turno entrando. <b>Estimativa:</b> conforme as urnas chegam, cada estado troca a prévia pela sua apuração (corrigida pela curva de erro do 1º turno); a prévia ainda pesa enquanto o estado tem menos de ${APURACAO_PLENA}% apurado. Taxas editáveis — fontes: ${FONTES}.`;
  $('proj-nota-2t').hidden = false;
  if (!CAL) $('sec-2t').hidden = true;
}
criarCharts();
initSegundoTurno();
renderTopo();
renderLegendas();
atualizar();
iniciarMapa();
atualizarMunicipios();
setInterval(atualizar, 30000);
setInterval(atualizarMunicipios, 30000);
