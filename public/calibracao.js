// Estimativa do 2º turno: calibração aprendida com o 1º turno + prévia a partir das pesquisas.
//
// 1) Prévia (antes de qualquer urna): o resultado final do 1º turno de cada estado passa pelo modelo de transferência
//    (transferencia.js): Lula e Flávio mantêm os votos, a terceira via se divide pelas taxas das pesquisas e parte dos
//    abstencionistas do 1º turno entra votando. Dá o Lula × Flávio "esperado" por estado, região e Brasil.
//
// 2) Curva de correção por estado: a projeção simples (calc.js › projetar) mantém, em cada estado, os percentuais que
//    ele tem no momento. Mas as urnas não chegam em ordem aleatória: no 1º turno, em quase todo estado as últimas urnas
//    favoreciam Lula, e a projeção subestimou Lula em todos os momentos (−1,7 p.p. com 29% apurado). Para cada % de
//    apuração DO ESTADO, medimos quanto a fatia de Lula ainda andou dali até o final — sobre os votos já convertidos
//    para o 2º turno (Lula₂ ÷ (Lula₂ + Flávio₂)), porque a terceira via não se distribui igual entre urnas cedo e tarde
//    (Caiado em GO, Zema em MG…). Hipótese: a ordem de chegada das urnas dentro de cada estado se repete entre os turnos.
//
// 3) Estimativa ao vivo (estimar): cada estado tem a fatia deslocada pela curva na apuração em que está e é projetado a
//    100%. Estado sem apuração usa a prévia; abaixo de APURACAO_PLENA % apurado, a prévia ainda pesa (média ponderada
//    pela apuração), para que poucas urnas de um estado não dominem a estimativa.
import { agregar, projetar } from './calc.js';
import { votosSegundoTurno, paramsPadrao, LULA, FLAVIO } from './transferencia.js';

export { LULA, FLAVIO };
/** % de apuração do estado a partir do qual a prévia deixa de pesar na estimativa dele. */
export const APURACAO_PLENA = 20;

const r3 = (v) => Math.round(v * 1000) / 1000;
export const fatiaLula = (votos) => { const t = (votos[LULA] || 0) + (votos[FLAVIO] || 0); return t ? (votos[LULA] / t) * 100 : null; };
const fatia2 = (e, p) => { const v = votosSegundoTurno(e, p); return v.validos ? (v.lula / v.validos) * 100 : null; };
const pcts = (v) => ({ ...v, pLula: v.validos ? (v.lula / v.validos) * 100 : 0, pFlavio: v.validos ? (v.flavio / v.validos) * 100 : 0 });

/**
 * snaps: lista de snapshots hidratados do 1º turno (cada um = lista de estados, com `abstencao1` = abstenção final do
 * estado), em ordem; o último é o resultado final. `params`: taxas de transferência (transferencia.js).
 */
export function construirCalibracao(snaps, params = paramsPadrao()) {
  const final = snaps.at(-1);
  const fin = Object.fromEntries(final.map((e) => [e.uf, fatia2(e, params)]));
  const F = agregar(final), fatiaFinal = fatiaLula(F.votos);
  const ufs = {};
  for (const est of snaps) for (const e of est) {
    const s = fatia2(e, params);
    if (s == null || fin[e.uf] == null || e.apuracao >= 100) continue;
    const c = (ufs[e.uf] ??= []);
    const a = r3(e.apuracao);
    if (c.length && c.at(-1)[0] >= a) { if (c.at(-1)[0] === a) c.at(-1)[1] = r3(fin[e.uf] - s); continue; }
    c.push([a, r3(fin[e.uf] - s)]);
  }
  for (const c of Object.values(ufs)) c.push([100, 0]);
  const inicio = Object.fromEntries(Object.entries(ufs).map(([uf, c]) => [uf, c[0][0]])); // primeiro % apurado gravado de cada estado
  const forma = estenderCurvas(ufs, Object.fromEntries(final.map((e) => [e.uf, e.eleitorado])));
  // erro da projeção simples (nacional) em cada momento, para exibição
  const nacional = snaps.map((est) => {
    const A = agregar(est), P = agregar(est.map(projetar));
    return { apuracao: r3(A.apuracao), lula: r3(P.pct[LULA] - F.pct[LULA]), flavio: r3(P.pct[FLAVIO] - F.pct[FLAVIO]), fatia: r3(fatiaLula(P.votos) - fatiaFinal) };
  });
  // prévia: 2º turno esperado a partir do resultado final do 1º, por estado e no Brasil
  const previa = { ufs: {}, br: null };
  const br = { votos: Object.fromEntries(Object.keys(final[0].votos).map((k) => [k, 0])), abstencao: 0, eleitorado: 0 };
  for (const e of final) {
    const v = votosSegundoTurno(e, params);
    previa.ufs[e.uf] = { ...pcts(v), eleitorado: e.eleitorado, votos1: e.votos, abstencao1: e.abstencao1 ?? null };
    for (const [k, x] of Object.entries(e.votos)) br.votos[k] += x;
    br.abstencao += e.abstencao1 ?? 0; br.eleitorado += e.eleitorado;
  }
  previa.br = { ...pcts(votosSegundoTurno(br, params)), eleitorado: br.eleitorado, votos1: br.votos, abstencao1: br.abstencao };
  return { base: '1º turno 2026', params, final: { lula: F.pct[LULA], flavio: F.pct[FLAVIO], fatia: fatiaFinal }, ufs, inicio, forma, nacional, previa };
}

/** Estados cuja curva começa até este % apurado servem de referência para o formato comum. */
export const INICIO_REFERENCIA = 25;
const GRADE = Array.from({ length: 21 }, (_, i) => i * 5); // 0, 5, …, 100

/**
 * Estende cada curva para baixo do primeiro ponto gravado. A gravação do 1º turno começou com 28% do país apurado,
 * e estados que totalizaram rápido (DF, TO, MS, PR…) só têm curva a partir de 55–88%. Repetir o primeiro valor
 * subestima a correção, porque no 1º turno o viés crescia quanto menos apurado. Modelo: Δ_uf(a) ≈ k_uf · G(a), com
 * G = formato médio (ponderado pelo eleitorado) das curvas dos estados com dado cedo, cada uma normalizada pela sua
 * escala (RMS, com sinal). Abaixo do início a₀: Δ(a) = Δ(a₀) · G(a) ÷ G(a₀) (contínua em a₀); se G(a₀) ≈ 0 (início
 * perto de 100%), usa Δ(a₀) + k·(G(a) − G(a₀)) com k por mínimos quadrados nos pontos observados.
 * Validação (leave-one-out nos estados com dado cedo, curva cortada em 60%): erro RMS 1,50 → 1,19 p.p. entre 20% e 40%.
 * Altera `ufs` no lugar; devolve o formato G (para exibição).
 */
export function estenderCurvas(ufs, eleitorado = {}) {
  const refs = Object.entries(ufs).filter(([, c]) => c[0][0] <= INICIO_REFERENCIA);
  if (refs.length < 3) return null;
  const G = GRADE.map(() => 0);
  let pesoTotal = 0;
  for (const [uf, c] of refs) {
    const v = GRADE.map((a) => ajusteUF(c, a));
    const rms = Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
    if (rms < 0.05) continue;
    const sinal = Math.sign(v.reduce((s, x) => s + x, 0)) || 1;
    const w = eleitorado[uf] || 1;
    v.forEach((x, i) => { G[i] += (w * sinal * x) / rms; });
    pesoTotal += w;
  }
  if (!pesoTotal) return null;
  G.forEach((x, i) => { G[i] = x / pesoTotal; });
  const g = (a) => ajusteUF(GRADE.map((x, i) => [x, G[i]]), a);
  for (const [, c] of Object.entries(ufs)) {
    const [a0, d0] = c[0];
    if (a0 <= 0) continue;
    // k por mínimos quadrados (Δ = k·G) nos pontos observados
    let sgg = 0, sgd = 0;
    for (const [a, d] of c) { const x = g(a); sgg += x * x; sgd += x * d; }
    const k = sgg > 1e-6 ? sgd / sgg : 0;
    const g0 = g(a0);
    const f = Math.abs(g0) > 0.1 ? (a) => (d0 * g(a)) / g0 : (a) => d0 + k * (g(a) - g0);
    const novos = GRADE.filter((a) => a < a0).map((a) => [a, r3(f(a))]);
    c.unshift(...novos);
  }
  return G;
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

/** Projeção com 100% apurado usando só a calibração (sem a prévia). */
export const projetarCalibrado = (lista, cal) => agregar(lista.map((e) => projetar(calibrar(e, cal))));

/** Peso da apuração do estado na estimativa dele (0 = só prévia, 1 = só projeção calibrada). */
export const pesoApuracao = (e) => Math.min(1, Math.max(0, e.apuracao) / APURACAO_PLENA);

/**
 * Estimativa final de um estado do 2º turno: projeção calibrada, misturada com a prévia enquanto a apuração é baixa.
 * Devolve uma unidade no formato de `projetar` (100% apurado), mais `peso` (da apuração) e `previa` (do estado).
 */
export function estimarUF(e, cal) {
  const c = projetar(calibrar(e, cal));
  const prev = cal?.previa?.ufs[e.uf];
  if (!prev) return { ...c, peso: 1, previa: null };
  const temVotos = (e.votos?.[LULA] || 0) + (e.votos?.[FLAVIO] || 0) > 0;
  const w = temVotos ? pesoApuracao(e) : 0;
  const mix = (obs, pre) => Math.round(w * obs + (1 - w) * pre);
  return { ...c, peso: w, previa: prev, votos: { ...c.votos, [LULA]: mix(c.votos[LULA] || 0, prev.lula), [FLAVIO]: mix(c.votos[FLAVIO] || 0, prev.flavio) } };
}

/** Estimativa agregada (Brasil, região ou estado): mesmo formato de `agregar`. */
export const estimar = (lista, cal) => agregar(lista.map((e) => estimarUF(e, cal)));

/** Prévia agregada de um conjunto de estados (mesmas chaves de votosSegundoTurno) ou null sem calibração. */
export function previaDe(lista, cal) {
  if (!cal?.previa) return null;
  const t = { lula: 0, flavio: 0, sem: 0, novos: 0, validos: 0 };
  for (const e of lista) { const p = cal.previa.ufs[e.uf]; if (!p) continue; for (const k of Object.keys(t)) t[k] += p[k]; }
  return pcts(t);
}

/**
 * Compara a apuração atual com o 1º turno NO MESMO PONTO: a fatia de Lula (votos já convertidos para o 2º turno) que
 * cada estado tinha no 1º turno quando estava com o mesmo % apurado de hoje, ponderada pelos votos Lula + Flávio já
 * apurados. `swing` = hoje − 1º turno nesse ponto. `extrapolado` = fração dos votos vinda de estados abaixo do primeiro
 * ponto gravado no 1º turno (ali a curva é estendida pelo formato comum, ver estenderCurvas). null sem votos ou sem calibração.
 */
export function comparar1T(lista, cal) {
  if (!cal?.previa) return null;
  let peso = 0, soma = 0, extrap = 0;
  for (const e of lista) {
    const t = (e.votos?.[LULA] || 0) + (e.votos?.[FLAVIO] || 0);
    const p = cal.previa.ufs[e.uf], c = cal.ufs[e.uf];
    if (!t || !p) continue;
    soma += t * (p.pLula - ajusteUF(c, e.apuracao)); peso += t;
    if (!c?.length || e.apuracao < (cal.inicio?.[e.uf] ?? c[0][0])) extrap += t;
  }
  if (!peso) return null;
  const hoje = fatiaLula(agregar(lista).votos), s1 = soma / peso;
  return { s1, hoje, swing: hoje - s1, extrapolado: extrap / peso };
}
