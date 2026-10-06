import { CANDIDATOS, REGIOES } from './data.js';
import { agregar, projetar, fmtInt, fmtPct } from './calc.js';
import { ajusteUF, LULA, FLAVIO } from './calibracao.js';

const $ = (id) => document.getElementById(id);
const cs = CANDIDATOS.filter((c) => c.destaque);
const pp = (v) => `${v >= 0 ? '+' : ''}${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} p.p.`;
const lider = (a) => (a.validos ? `<span style="color:${a.lider.cor}">${a.lider.nome}</span> ${fmtPct(a.pct[a.lider.id], 1)}` : '—');

let dados = null;   // /api/historico
let chart = null;
let pos = 0;        // posição no vetor de percentis
const TQ = new URLSearchParams(location.search).get('turno'); // turno escolhido (padrão: o turno em andamento)
const qs = TQ ? `turno=${TQ}` : '';

async function carregar(manterPos) {
  dados = await (await fetch(`/api/historico?${qs}`, { cache: 'no-store' })).json();
  $('turnos').innerHTML = [1, 2].map((t) => `<a href="?turno=${t}" ${dados.turno === t ? 'aria-current="page"' : ''}>${t}º turno</a>`).join('');
  $('csv').href = `/api/historico.csv?turno=${dados.turno}`;
  const n = dados.percentis.length;
  $('gravacao').textContent = `${dados.total} snapshots gravados`;
  $('slider').max = Math.max(0, n - 1);
  if (!n) {
    $('momento').textContent = 'Ainda não há registros com 1% de apuração. Deixe o servidor rodando.';
    return;
  }
  if (!manterPos) pos = n - 1;
  $('slider').value = pos;
  desenharEvolucao();
  await mostrar();
}

async function mostrar() {
  const r = dados.percentis[pos];
  const snap = await (await fetch(`/api/snapshot?i=${r.i}&turno=${dados.turno}`)).json();
  $('momento').innerHTML = `Percentil <b>${r.p}%</b> · apuração real <b>${fmtPct(snap.apuracao)}</b> · arquivo TSE de <b>${snap.tse}</b>`;
  $('aviso').textContent = `Gravado em ${new Date(snap.t).toLocaleString('pt-BR')}. ${dados.percentis.length} percentis registrados de 100.`;

  const est = snap.estados;
  const atual = agregar(est), proj = agregar(est.map(projetar));
  const l = proj.ranking[0], s2 = proj.ranking[1];
  $('veredito').innerHTML = !proj.validos ? 'Sem votos.' : proj.pct[l.id] > 50
    ? `<b style="color:${l.cor}">${l.nome}</b> venceria no 1º turno (${fmtPct(proj.pct[l.id])}).`
    : `2º turno: <b style="color:${l.cor}">${l.nome}</b> ${fmtPct(proj.pct[l.id])} × <b style="color:${s2.cor}">${s2.nome}</b> ${fmtPct(proj.pct[s2.id])}.`;

  // apuração encerrada: compara a projeção daquele momento com o resultado final
  const fin = dados.ultimo && dados.ultimo.apuracao >= 99.99 ? dados.ultimo.atual : null;
  $('t-cands').innerHTML = `<thead><tr><th>Candidato</th><th>Real</th><th>Projetado</th><th>Variação</th>${fin ? '<th>Final</th><th>Erro da projeção</th>' : ''}<th>Votos projetados</th></tr></thead><tbody>${
    [...CANDIDATOS].sort((a, b) => proj.pct[b.id] - proj.pct[a.id]).slice(0, 6).map((c) => `<tr><td><span style="color:${c.cor}">●</span> ${c.nome}</td>
      <td>${fmtPct(atual.pct[c.id])}</td><td><b>${fmtPct(proj.pct[c.id])}</b></td>
      <td style="color:${proj.pct[c.id] >= atual.pct[c.id] ? '#16a34a' : '#dc2626'}">${pp(proj.pct[c.id] - atual.pct[c.id])}</td>
      ${fin ? `<td>${fmtPct(fin[c.id])}</td><td><b>${pp(proj.pct[c.id] - fin[c.id])}</b></td>` : ''}
      <td>${fmtInt.format(proj.votos[c.id])}</td></tr>`).join('')}</tbody>`;

  $('t-regioes').innerHTML = `<thead><tr><th>Região</th><th>Apurado</th><th>Líder real</th><th>Líder projetado</th><th>Eleitores</th></tr></thead><tbody>${
    Object.entries(REGIOES).map(([id, reg]) => {
      const l2 = est.filter((e) => e.regiao === id);
      const a = agregar(l2), p = agregar(l2.map(projetar));
      return `<tr><td>${reg.nome}</td><td>${fmtPct(a.apuracao, 1)}</td><td>${lider(a)}</td><td><b>${lider(p)}</b></td><td>${fmtInt.format(a.eleitorado)}</td></tr>`;
    }).join('')}</tbody>`;

  marcarPonto();
}

function desenharEvolucao() {
  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  const labels = dados.percentis.map((r) => `${r.p}%`);
  const datasets = [
    ...cs.map((c) => ({ label: `${c.nome} (proj.)`, data: dados.percentis.map((r) => r.proj[c.id]), borderColor: c.cor, backgroundColor: c.cor, tension: .25, pointRadius: 0 })),
    ...cs.slice(0, 2).map((c) => ({ label: `${c.nome} (real)`, data: dados.percentis.map((r) => r.atual[c.id]), borderColor: c.cor, borderDash: [5, 4], pointRadius: 0, tension: .25 })),
  ];
  if (chart) chart.destroy();
  chart = new Chart($('chart-evo'), {
    type: 'line', data: { labels, datasets },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPct(c.parsed.y)}` } } },
      scales: { x: { title: { display: true, text: '% de apuração geral' } }, y: { ticks: { callback: (v) => `${v}%` } } },
    },
  });
}
function marcarPonto() {
  if (!chart) return;
  chart.data.datasets.forEach((d) => { d.pointRadius = d.data.map((_, i) => (i === pos ? 6 : 0)); });
  chart.update();
}

// ---------- calibração aprendida com o 1º turno ----------
async function mostrarCalibracao() {
  const r = await fetch('/api/calibracao');
  if (!r.ok) return;
  const cal = await r.json();
  $('sec-cal').hidden = false;
  const lula = CANDIDATOS.find((c) => c.id === LULA), flavio = CANDIDATOS.find((c) => c.id === FLAVIO);
  const p0 = cal.nacional[0];
  $('cal-resumo').innerHTML = `A projeção simples <b>subestimou <span style="color:${lula.cor}">Lula</span></b> durante toda a apuração: com ${fmtPct(p0.apuracao, 1)} apurado, errou ${pp(p0.lula)} em Lula e ${pp(p0.flavio)} em Flávio; o erro foi caindo até zero. Resultado final: Lula ${fmtPct(cal.final.lula)}, Flávio ${fmtPct(cal.final.flavio)}.`;
  new Chart($('chart-erro'), {
    type: 'line',
    data: { datasets: [
      { label: 'Erro em Lula', data: cal.nacional.map((n) => ({ x: n.apuracao, y: n.lula })), borderColor: lula.cor, backgroundColor: lula.cor, pointRadius: 0, tension: 0.2 },
      { label: 'Erro em Flávio Bolsonaro', data: cal.nacional.map((n) => ({ x: n.apuracao, y: n.flavio })), borderColor: flavio.cor, backgroundColor: flavio.cor, pointRadius: 0, tension: 0.2 },
    ] },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { title: (i) => `${fmtPct(i[0].parsed.x, 1)} apurado`, label: (c) => ` ${c.dataset.label}: ${pp(c.parsed.y)}` } } },
      scales: { x: { type: 'linear', min: 0, max: 100, title: { display: true, text: '% de apuração geral' }, ticks: { callback: (v) => `${v}%` } },
        y: { title: { display: true, text: 'projetado − final' }, ticks: { callback: (v) => `${v > 0 ? '+' : ''}${v} p.p.` } } },
    },
  });
  const niveis = [10, 30, 50, 70, 90, 99];
  const nomeUf = Object.fromEntries((await import('./data.js')).ESTADOS.map((e) => [e.uf, e.nome]));
  const linhas = Object.entries(cal.ufs).sort(([a], [b]) => nomeUf[a].localeCompare(nomeUf[b]));
  $('t-cal').innerHTML = `<thead><tr><th>Estado</th>${niveis.map((n) => `<th>com ${n}% apurado</th>`).join('')}</tr></thead><tbody>${linhas.map(([uf, c]) => `<tr><td>${nomeUf[uf]}</td>${niveis.map((n) => {
    const v = ajusteUF(c, n), fora = n < c[0][0];
    return `<td style="color:${v > 0.05 ? lula.cor : v < -0.05 ? flavio.cor : 'inherit'}">${fora ? `<i>${pp(v)}</i>` : pp(v)}</td>`;
  }).join('')}</tr>`).join('')}</tbody>`;
}
mostrarCalibracao();

const ir = (p) => { pos = Math.min(Math.max(p, 0), dados.percentis.length - 1); $('slider').value = pos; mostrar(); };
$('slider').addEventListener('input', (e) => ir(+e.target.value));
$('ant').addEventListener('click', () => ir(pos - 1));
$('prox').addEventListener('click', () => ir(pos + 1));
$('ultimo').addEventListener('click', async () => { await carregar(false); });
carregar(false);
setInterval(() => carregar(true), 60000);
