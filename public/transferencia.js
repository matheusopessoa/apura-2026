// Modelo de transferência de votos do 1º para o 2º turno (Lula × Flávio Bolsonaro), a partir das pesquisas de 2º turno.
//
// Dois ingredientes, ambos editáveis no painel:
//  1) Para onde vai cada eleitor da terceira via (média da última pesquisa disponível de cada instituto, out/2026).
//     O "total ponderado" da terceira via (50,1% Flávio · 33,6% Lula · 16,3% outros) é usado para os demais candidatos.
//  2) Quem não votou no 1º turno e vota no 2º (média simples de AtlasIntel 13–18/10 e Quaest 10–13/10 e 17–20/10):
//     46,23% Lula · 38,07% Flávio · 15,70% branco/nulo/indeciso. Esses eleitores saem da ABSTENÇÃO real de cada
//     estado no 1º turno; `comparecem` é a fração deles que de fato vota no 2º (hipótese, não há pesquisa).
// Eleitores de Lula e de Flávio repetem o voto. "Outros" = branco, nulo, abstenção declarada e indecisos (não contam como válidos).
import { CANDIDATOS } from './data.js';

export const LULA = '13', FLAVIO = '22';

export const GRUPOS = [ // % → Flávio, % → Lula; o resto vai para branco/nulo/indeciso
  { chave: 'renan',  nome: 'Renan Santos',      ids: ['14'], f: 49.7, l: 26.5 },
  { chave: 'caiado', nome: 'Ronaldo Caiado',    ids: ['55'], f: 58.0, l: 27.3 },
  { chave: 'cury',   nome: 'Augusto Cury',      ids: ['70'], f: 42.4, l: 45.3 },
  { chave: 'zema',   nome: 'Romeu Zema',        ids: ['30'], f: 72.8, l: 17.8 },
  { chave: 'demais', nome: 'Demais candidatos', ids: CANDIDATOS.filter((c) => !['13', '22', '14', '55', '70', '30'].includes(c.id)).map((c) => c.id), f: 50.1, l: 33.6 },
];
export const NOVOS = { chave: 'novos', nome: 'Não votou no 1º turno', f: 38.07, l: 46.23, comparecem: 10 };
export const FONTES = 'terceira via: média da última pesquisa de cada instituto (out/2026) · quem não votou no 1º turno: média de AtlasIntel (13–18/10) e Quaest (10–13/10 e 17–20/10)';

export const paramsPadrao = () => ({
  ...Object.fromEntries(GRUPOS.map((g) => [g.chave, { f: g.f, l: g.l }])),
  novos: { f: NOVOS.f, l: NOVOS.l, comparecem: NOVOS.comparecem },
});

const pct = (v, padrao) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : padrao; };
/** Garante f + l ≤ 100 em cada grupo (se passar, reduz os dois na mesma proporção). */
export function normalizar(p) {
  const out = {};
  for (const [k, g] of Object.entries(p)) {
    let f = pct(g.f, 0), l = pct(g.l, 0);
    const excede = f + l > 100;
    if (excede) { const r = 100 / (f + l); f *= r; l *= r; }
    out[k] = { ...g, f, l, excede };
    if (k === 'novos') out[k].comparecem = pct(g.comparecem, NOVOS.comparecem);
  }
  return out;
}

/** Parâmetros a partir de uma query string: ?renan=49.7,26.5&novos=38.07,46.23,20 (ausentes → padrão). */
export function paramsDeQuery(sp) {
  const p = paramsPadrao();
  for (const k of Object.keys(p)) {
    const v = sp.get(k);
    if (!v) continue;
    const [f, l, c] = v.split(',');
    p[k] = { ...p[k], f: pct(f, p[k].f), l: pct(l, p[k].l), ...(k === 'novos' && { comparecem: pct(c, p[k].comparecem) }) };
  }
  return normalizar(p);
}
export const queryDeParams = (p) => Object.entries(p).map(([k, g]) => `${k}=${[g.f, g.l, ...(k === 'novos' ? [g.comparecem] : [])].map((x) => Math.round(x * 100) / 100).join(',')}`).join('&');

const r2 = (v) => Math.round(v * 100) / 100;
export const chaveDe = (p) => Object.entries(p).map(([k, g]) => `${k}:${r2(g.f)},${r2(g.l)}${k === 'novos' ? `,${r2(g.comparecem)}` : ''}`).join('|');

/** Abstenção do 1º turno nas seções já apuradas de uma unidade: lida do TSE (`abstencao`) ou, num snapshot antigo, a abstenção final do estado × fração apurada. */
export function abstencaoApurada(e) {
  if (Number.isFinite(e.abstencao)) return e.abstencao;
  if (!Number.isFinite(e.abstencao1)) return 0;
  const frac = e.eleitoradoApurado > 0 && e.eleitorado > 0 ? e.eleitoradoApurado / e.eleitorado : (e.apuracao || 0) / 100;
  return e.abstencao1 * Math.min(1, frac);
}

/**
 * Votos de Lula e Flávio no 2º turno equivalentes a uma unidade do 1º turno (estado, município ou agregado).
 * `e`: { votos, abstencao? | abstencao1?, eleitorado?, eleitoradoApurado?, apuracao? }. Devolve também `sem`
 * (branco/nulo/indeciso gerados pela transferência) e `novos` (eleitores que não votaram no 1º turno).
 */
export function votosSegundoTurno(e, p = paramsPadrao()) {
  const v = e.votos || {};
  let lula = v[LULA] || 0, flavio = v[FLAVIO] || 0, sem = 0;
  const grupos = {};
  for (const g of GRUPOS) {
    const tot = g.ids.reduce((s, id) => s + (v[id] || 0), 0);
    const { f, l } = p[g.chave] ?? g;
    grupos[g.chave] = tot;
    flavio += (tot * f) / 100; lula += (tot * l) / 100; sem += (tot * Math.max(0, 100 - f - l)) / 100;
  }
  const n = p.novos ?? NOVOS;
  const novos = (abstencaoApurada(e) * n.comparecem) / 100;
  flavio += (novos * n.f) / 100; lula += (novos * n.l) / 100; sem += (novos * Math.max(0, 100 - n.f - n.l)) / 100;
  const validos = lula + flavio;
  return { lula, flavio, sem, novos, validos, grupos, pLula: validos ? (lula / validos) * 100 : 0, pFlavio: validos ? (flavio / validos) * 100 : 0 };
}
