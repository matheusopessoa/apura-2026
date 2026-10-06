// Governador de Pernambuco · 1º turno 2026 (eleição estadual 6259, cargo 0003).
import { agregar, projetar, fmtInt, fmtPct, situacao as calcSituacao, alertaResultado } from './calc.js';

const $ = (id) => document.getElementById(id);
const BASE = '/tse/ele2026/6259';
const E6 = '006259';
const CARGO = '0003';
const COR = { 55: '#f59e0b', 40: '#e11d48', 50: '#7c3aed', 14: '#db2777', 80: '#65a30d', 16: '#a8a29e', 29: '#c2410c' };
const COR_ELEIT = ['#0ea5e9', '#f97316', '#84cc16', '#8b5cf6', '#14b8a6', '#eab308', '#ec4899', '#6366f1', '#94a3b8'];
const num = (v) => Number(v) || 0;
const titulo = (t) => t.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Da|Do|Dos|Das|E) /g, (m) => m.toLowerCase());
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const state = { cands: [], munis: [], nomes: null, atualizado: null, erro: null, ordem: { chave: 'eleitorado', dir: -1 }, topIds: [] };

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r.json();
}

async function carregar() {
  if (!state.nomes) {
    const cfg = await getJson(`${BASE}/config/mun-e${E6}-cm.json`);
    state.nomes = Object.fromEntries((cfg?.abr.find((a) => a.cd === 'pe')?.mu ?? []).map((m) => [m.cd, titulo(m.nm)]));
  }
  const [ab, uf] = await Promise.all([getJson(`${BASE}/dados/pe/pe-e${E6}-ab.json`), getJson(`${BASE}/dados/pe/pe-c${CARGO}-e${E6}-u.json`)]);
  if (!ab || !uf) throw new Error('arquivos do estado indisponíveis');

  // candidatos vêm do próprio arquivo do TSE
  const cands = [];
  for (const agr of uf.carg[0].agr) for (const par of agr.par ?? []) for (const c of par.cand ?? [])
    cands.push({ id: String(c.n), numero: c.n, nome: titulo(c.nmu || c.nm), partido: par.sg, cor: COR[c.n] || '#94a3b8' });
  state.cands = cands;

  const lista = ab.abr.filter((a) => a.tpabr === 'mun');
  const munis = new Array(lista.length);
  let prox = 0;
  const worker = async () => {
    while (prox < lista.length) {
      const i = prox++;
      const a = lista[i];
      const u = await getJson(`${BASE}/dados/pe/pe${a.cdabr}-c${CARGO}-e${E6}-u.json`);
      const votos = Object.fromEntries(cands.map((c) => [c.id, 0]));
      for (const agr of u?.carg?.[0]?.agr ?? []) for (const par of agr.par ?? []) for (const c of par.cand ?? []) if (c.n in votos) votos[c.n] += num(c.vap);
      const ts = num(a.s.ts), st = num(a.s.st);
      munis[i] = { uf: a.cdabr, nome: state.nomes[a.cdabr] || a.cdabr, eleitorado: num(a.e.te), eleitoradoApurado: num(a.e.est), secoes: { total: ts, apuradas: st }, apuracao: ts ? (st / ts) * 100 : 0, votos };
    }
  };
  await Promise.all(Array.from({ length: 20 }, worker));
  state.munis = munis;
  state.atualizado = `${ab.dg} ${ab.hg}`;
  if (!state.topIds.length) state.topIds = agregar(munis, cands).ranking.slice(0, 3).map((c) => c.id);
}

/** Leva cada município a 100%. Quem ainda tem 0% usa o comparecimento e os percentuais dos já apurados. */
function projetarTudo(munis) {
  const proj = munis.filter((m) => m.apuracao > 0).map(projetar);
  const base = agregar(proj, state.cands);
  const razao = base.eleitorado ? base.validos / base.eleitorado : 0;
  const zerados = munis.filter((m) => m.apuracao <= 0).map((m) => ({
    ...m, apuracao: 100, secoes: { ...m.secoes, apuradas: m.secoes.total },
    votos: Object.fromEntries(state.cands.map((c) => [c.id, Math.round((m.eleitorado * razao * base.pct[c.id]) / 100)])),
  }));
  return { lista: [...proj, ...zerados], imputados: zerados.length };
}

// ---------- gráficos ----------
let chartCands; const pizzas = {};
function criarCharts() {
  Chart.defaults.color = css('--muted');
  chartCands = new Chart($('chart-cands'), {
    type: 'bar', data: { labels: [], datasets: [] },
    options: { indexAxis: 'y', maintainAspectRatio: false, animation: { duration: 400 },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPct(c.parsed.x)}` } } },
      scales: { x: { min: 0, grid: { color: css('--line') }, ticks: { callback: (v) => `${v}%` } }, y: { grid: { display: false } } } },
  });
  for (const id of ['pizza-real', 'pizza-proj', 'pizza-eleit']) {
    pizzas[id] = new Chart($(id), {
      type: 'pie', data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: css('--card'), borderWidth: 2 }] },
      options: { maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${id === 'pizza-eleit' ? fmtInt.format(c.parsed) : fmtPct(c.parsed)}` } } } },
    });
  }
}

function pizza(id, itens, fmt) {
  const ch = pizzas[id];
  ch.data.labels = itens.map((x) => x.n);
  ch.data.datasets[0].data = itens.map((x) => x.v);
  ch.data.datasets[0].backgroundColor = itens.map((x) => x.c);
  ch.update();
  $(`${id}-l`).innerHTML = itens.map((x) => `<span style="--c:${x.c}">${x.n} <b>${fmt(x)}</b></span>`).join('');
}

// ---------- render ----------
const fatias = (a) => {  // abaixo de 1,5% vira "Demais"
  const grandes = a.ranking.filter((c) => a.pct[c.id] >= 1.5);
  const resto = 100 - grandes.reduce((s, c) => s + a.pct[c.id], 0);
  const v = grandes.map((c) => ({ n: c.nome, v: a.pct[c.id], c: c.cor }));
  return a.validos && resto > 0.05 ? [...v, { n: 'Demais', v: resto, c: '#94a3b8' }] : v;
};

function render() {
  const { cands, munis } = state;
  const hoje = agregar(munis, cands);
  const { lista, imputados } = projetarTudo(munis);
  const proj = agregar(lista, cands);
  const l = hoje.ranking[0], s2 = hoje.ranking[1];

  $('modo').textContent = state.erro ? 'ERRO NA LEITURA' : 'AO VIVO · TSE';
  $('modo').className = `badge ${state.erro ? 'sim' : 'live'}`;
  $('atualizado').textContent = state.erro || `Arquivo TSE de ${state.atualizado}`;

  const sit = calcSituacao(munis, cands);
  const alerta = alertaResultado(sit, 'para Governador de PE');
  $('alerta').className = alerta ? `alerta ${alerta.tipo}` : 'alerta';
  $('alerta').innerHTML = alerta ? alerta.html : '';
  const situacao = sit.eleito ? `${l.nome} eleito(a) no 1º turno` : sit.segundoTurno ? 'Haverá 2º turno'
    : hoje.pct[l.id] > 50 ? `${l.nome} acima de 50% (ainda pode cair)` : 'Em apuração';
  $('kpis').innerHTML = `
    <div class="kpi"><div class="l">Apuração PE</div><div class="v">${fmtPct(hoje.apuracao)}</div><div class="s">das seções totalizadas</div></div>
    <div class="kpi"><div class="l">Eleitorado de PE</div><div class="v">${fmtInt.format(hoje.eleitorado)}</div><div class="s">${munis.length} municípios</div></div>
    <div class="kpi"><div class="l">Líder</div><div class="v" style="color:${l.cor}">${fmtPct(hoje.pct[l.id])}</div><div class="s">${l.nome} (${l.partido})</div></div>
    <div class="kpi"><div class="l">2º colocado</div><div class="v" style="color:${s2.cor}">${fmtPct(hoje.pct[s2.id])}</div><div class="s">${s2.nome} · diferença ${fmtPct(hoje.pct[l.id] - hoje.pct[s2.id]).replace('%', ' p.p.')}</div></div>
    <div class="kpi"><div class="l">Situação</div><div class="v" style="font-size:1.1rem;line-height:1.9rem">${situacao}</div><div class="s">${fmtInt.format(hoje.validos)} votos válidos</div></div>`;

  // projeção
  const pl = proj.ranking[0], ps = proj.ranking[1];
  $('veredito').innerHTML = proj.pct[pl.id] > 50
    ? `<b style="color:${pl.cor}">${pl.nome}</b> seria eleito(a) no 1º turno (${fmtPct(proj.pct[pl.id])} dos válidos).`
    : `Iria a <b>2º turno</b>: <b style="color:${pl.cor}">${pl.nome}</b> ${fmtPct(proj.pct[pl.id])} × <b style="color:${ps.cor}">${ps.nome}</b> ${fmtPct(proj.pct[ps.id])}.`;
  $('nota').textContent = `Estimativa: cada município é levado a 100% do seu eleitorado (votos válidos por eleitor nas urnas já apuradas × eleitorado total do município), mantendo seus percentuais atuais${imputados ? `; ${imputados} município(s) ainda sem urnas apuradas usam o comparecimento e os percentuais médios dos já apurados` : ''}. Não é previsão oficial — a ordem de chegada das urnas costuma enviesar o parcial.`;
  const ord = [...proj.ranking];
  $('t-cands').innerHTML = `<thead><tr><th>Candidato</th><th>Hoje</th><th>Projetado</th><th>Variação</th><th>Votos projetados</th></tr></thead><tbody>${ord.map((c) => {
    const d = proj.pct[c.id] - hoje.pct[c.id];
    return `<tr><td><span style="color:${c.cor}">●</span> ${c.nome} <span class="muted">${c.partido}</span></td><td>${fmtPct(hoje.pct[c.id])}</td><td><b>${fmtPct(proj.pct[c.id])}</b></td>
      <td style="color:${d >= 0 ? '#16a34a' : '#dc2626'}">${d >= 0 ? '+' : ''}${d.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.</td><td>${fmtInt.format(proj.votos[c.id])}</td></tr>`; }).join('')}</tbody>`;
  chartCands.data.labels = ord.map((c) => c.nome);
  chartCands.data.datasets = [
    { label: 'Hoje', data: ord.map((c) => hoje.pct[c.id]), backgroundColor: ord.map((c) => c.cor + '66'), borderRadius: 3 },
    { label: 'Projetado', data: ord.map((c) => proj.pct[c.id]), backgroundColor: ord.map((c) => c.cor), borderRadius: 3 },
  ];
  chartCands.update();

  // pizzas
  pizza('pizza-real', fatias(hoje), (x) => fmtPct(x.v, 1));
  pizza('pizza-proj', fatias(proj), (x) => fmtPct(x.v, 1));
  const maiores = [...munis].sort((a, b) => b.eleitorado - a.eleitorado).slice(0, 8);
  const resto = hoje.eleitorado - maiores.reduce((s, m) => s + m.eleitorado, 0);
  pizza('pizza-eleit', [...maiores.map((m, i) => ({ n: m.nome, v: m.eleitorado, c: COR_ELEIT[i] })), { n: 'Demais municípios', v: resto, c: COR_ELEIT[8] }],
    (x) => fmtPct((x.v / hoje.eleitorado) * 100, 1));
  $('pizza-eleit-t').textContent = `Eleitorado · ${fmtInt.format(hoje.eleitorado)} eleitores`;

  renderTabela(hoje);
}

function renderTabela() {
  const { cands, munis, ordem, topIds } = state;
  const termo = $('filtro').value.trim().toLowerCase();
  const val = (m) => ({ nome: m.nome, apuracao: m.apuracao, eleitorado: m.eleitorado }[ordem.chave]
    ?? (agregar([m], cands).pct[ordem.chave] || 0));
  const rows = munis.filter((m) => !termo || m.nome.toLowerCase().includes(termo))
    .map((m) => ({ m, a: agregar([m], cands) }))
    .sort((x, y) => (val(x.m) > val(y.m) ? 1 : val(x.m) < val(y.m) ? -1 : 0) * ordem.dir);
  $('tab-titulo').textContent = `Municípios · ${rows.length} de ${munis.length}`;
  const top = topIds.map((id) => cands.find((c) => c.id === id));
  const th = (k, t) => `<th data-k="${k}">${t}${ordem.chave === k ? (ordem.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  $('tabela').innerHTML = `<thead><tr>${th('nome', 'Município')}${th('apuracao', 'Apurado')}${th('eleitorado', 'Eleitorado')}<th>Líder hoje</th>${
    top.map((c) => th(c.id, `<span style="color:${c.cor}">●</span> ${c.nome.split(' ')[0]}`)).join('')}</tr></thead><tbody>${rows.map(({ m, a }) => `
    <tr><td>${m.nome}</td><td>${fmtPct(m.apuracao, 1)}<span class="mini"><i style="width:${m.apuracao}%"></i></span></td><td>${fmtInt.format(m.eleitorado)}</td>
    <td class="lider" style="color:${a.validos ? a.lider.cor : 'inherit'}">${a.validos ? a.lider.nome : '—'}</td>
    ${top.map((c) => `<td>${a.validos ? `<span class="${a.lider.id === c.id ? 'win' : ''}">${fmtPct(a.pct[c.id], 1)}</span>` : '—'}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

// ---------- ciclo ----------
let carregando = false;
async function atualizar() {
  if (carregando) return;
  carregando = true;
  try { await carregar(); state.erro = null; render(); }
  catch (err) { console.error(err); state.erro = `Falha ao ler o TSE: ${err.message}`; $('modo').textContent = 'ERRO NA LEITURA'; $('modo').className = 'badge sim'; $('atualizado').textContent = state.erro; }
  finally { carregando = false; }
}
document.addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-k]');
  if (!th) return;
  const k = th.dataset.k;
  state.ordem = { chave: k, dir: state.ordem.chave === k ? -state.ordem.dir : (k === 'nome' ? 1 : -1) };
  renderTabela();
});
$('filtro').addEventListener('input', () => state.munis.length && renderTabela());
$('btn-atualizar').addEventListener('click', atualizar);
criarCharts();
atualizar();
setInterval(atualizar, 60000);
