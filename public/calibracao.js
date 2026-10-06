// Calibração da projeção a partir de uma apuração já encerrada (1º turno 2026).
//
// A projeção simples (calc.js › projetar) mantém, em cada estado, os percentuais que ele tem no momento.
// Mas as urnas não chegam em ordem aleatória: no 1º turno, em quase todo estado as últimas urnas
// favoreciam Lula, e a projeção subestimou Lula em todos os momentos (−1,7 p.p. com 29% apurado).
//
// Curva por estado: para cada % de apuração DO ESTADO, quanto a fatia de Lula entre Lula e Flávio
// (Lula ÷ (Lula + Flávio)) ainda andou dali até o resultado final. No 2º turno, cada estado tem essa
// fatia deslocada pelo valor da curva na apuração em que ele está, e só então é projetado a 100%.
// Hipótese: a ordem de chegada das urnas dentro de cada estado se repete entre os turnos.
import { agregar, projetar } from './calc.js';

export const LULA = '13', FLAVIO = '22';
const r3 = (v) => Math.round(v * 1000) / 1000;
export const fatiaLula = (votos) => { const t = (votos[LULA] || 0) + (votos[FLAVIO] || 0); return t ? (votos[LULA] / t) * 100 : null; };

/** snaps: lista de snapshots hidratados (cada um = lista de estados), em ordem; o último é o resultado final. */
export function construirCalibracao(snaps) {
  const final = snaps.at(-1);
  const fin = Object.fromEntries(final.map((e) => [e.uf, fatiaLula(e.votos)]));
  const F = agregar(final), fatiaFinal = fatiaLula(F.votos);
  const ufs = {};
  for (const est of snaps) for (const e of est) {
    const s = fatiaLula(e.votos);
    if (s == null || fin[e.uf] == null || e.apuracao >= 100) continue;
    const c = (ufs[e.uf] ??= []);
    const a = r3(e.apuracao);
    if (c.length && c.at(-1)[0] >= a) { if (c.at(-1)[0] === a) c.at(-1)[1] = r3(fin[e.uf] - s); continue; }
    c.push([a, r3(fin[e.uf] - s)]);
  }
  for (const c of Object.values(ufs)) c.push([100, 0]);
  // erro da projeção simples (nacional) em cada momento, para exibição
  const nacional = snaps.map((est) => {
    const A = agregar(est), P = agregar(est.map(projetar));
    return { apuracao: r3(A.apuracao), lula: r3(P.pct[LULA] - F.pct[LULA]), flavio: r3(P.pct[FLAVIO] - F.pct[FLAVIO]), fatia: r3(fatiaLula(P.votos) - fatiaFinal) };
  });
  return { base: '1º turno 2026', final: { lula: F.pct[LULA], flavio: F.pct[FLAVIO], fatia: fatiaFinal }, ufs, nacional };
}

/** Deslocamento (p.p. na fatia de Lula) da curva `c` na apuração `a`. Abaixo do 1º ponto observado, usa o 1º ponto. */
export function ajusteUF(c, a) {
  if (!c?.length) return 0;
  if (a <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (a <= c[i][0]) { const [a0, v0] = c[i - 1], [a1, v1] = c[i]; return v0 + ((v1 - v0) * (a - a0)) / (a1 - a0 || 1); }
  }
  return 0;
}

/** Estado com os votos de Lula/Flávio redistribuídos pela curva (o total Lula + Flávio não muda). */
export function calibrar(e, cal) {
  const s = fatiaLula(e.votos);
  if (s == null || !cal?.ufs[e.uf] || e.apuracao >= 100) return e;
  const t = e.votos[LULA] + e.votos[FLAVIO];
  const l = Math.round((t * Math.min(100, Math.max(0, s + ajusteUF(cal.ufs[e.uf], e.apuracao)))) / 100);
  return { ...e, votos: { ...e.votos, [LULA]: l, [FLAVIO]: t - l } };
}

/** Projeção com 100% apurado usando a calibração (mesma lógica de projetar, depois do ajuste). */
export const projetarCalibrado = (lista, cal) => agregar(lista.map((e) => projetar(calibrar(e, cal))));
