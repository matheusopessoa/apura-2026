// Cálculos puros (usados pelo painel, pelo histórico e pelo servidor).
import { CANDIDATOS } from './data.js';

export const fmtInt = new Intl.NumberFormat('pt-BR');
export const fmtPct = (v, d = 2) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })}%`;

export function agregar(lista, cands = CANDIDATOS) {
  const eleitorado = lista.reduce((s, e) => s + e.eleitorado, 0);
  const secTotal = lista.reduce((s, e) => s + e.secoes.total, 0);
  const apuracao = secTotal ? (lista.reduce((s, e) => s + e.secoes.apuradas, 0) / secTotal) * 100 : 0;
  const votos = Object.fromEntries(cands.map((c) => [c.id, lista.reduce((s, e) => s + (e.votos[c.id] || 0), 0)]));
  const validos = Object.values(votos).reduce((a, b) => a + b, 0);
  const pct = Object.fromEntries(cands.map((c) => [c.id, validos ? (votos[c.id] / validos) * 100 : 0]));
  const ranking = [...cands].sort((a, b) => pct[b.id] - pct[a.id]);
  return { eleitorado, apuracao, votos, validos, pct, lider: validos ? ranking[0] : null, ranking };
}

// Projeção: leva cada unidade (estado/município) a 100%, mantendo os percentuais que ela tem hoje.
// Peso = eleitorado: votos válidos por eleitor nas urnas já apuradas × eleitorado total da unidade.
// (Sem o eleitorado apurado, ex.: snapshots antigos, usa a proporção de seções.)
export const projetar = (e) => {
  const f = e.eleitoradoApurado > 0 ? e.eleitorado / e.eleitoradoApurado : e.apuracao > 0 ? 100 / e.apuracao : 0;
  return { ...e, apuracao: 100, eleitoradoApurado: e.eleitorado, secoes: { ...e.secoes, apuradas: e.secoes.total },
    votos: Object.fromEntries(Object.entries(e.votos).map(([k, v]) => [k, Math.round(v * f)])) };
};


/**
 * Situação do 1º turno com garantia matemática (maioria absoluta dos votos válidos > 50%).
 * Pior caso do líder: TODOS os votos válidos que faltam (estimados pela projeção) vão para os outros.
 * Melhor caso: todos vão para ele. Se o pior caso já passa de 50% → eleito; se o melhor não chega a 50% → 2º turno.
 */
export function situacao(lista, cands = CANDIDATOS) {
  const h = agregar(lista, cands);
  const p = agregar(lista.map(projetar), cands);
  const falta = Math.max(0, p.validos - h.validos);
  const total = h.validos + falta;
  const l = h.ranking[0];
  const piso = total ? (h.votos[l.id] / total) * 100 : 0;
  const teto = total ? ((h.votos[l.id] + falta) / total) * 100 : 0;
  const ok = h.validos > 0;
  return { h, lider: l, falta, piso, teto, eleito: ok && piso > 50, segundoTurno: ok && teto <= 50, final: h.apuracao >= 99.99 };
}

/** Texto e HTML do aviso de resultado garantido (ou null enquanto indefinido). */
export function alertaResultado(sit, escopo) {
  const { lider: l, piso, teto, falta, final } = sit;
  const cor = `style="color:${l.cor}"`;
  const resto = fmtInt.format(Math.round(falta));
  if (sit.eleito) return { tipo: 'eleito', html: `✅ <b ${cor}>${l.nome}</b> está <b>ELEITO(A) no 1º turno</b> ${escopo}${final ? '' : ' — não tem mais como perder'}. ${final ? `Terminou com ${fmtPct(piso)} dos votos válidos.` : `Mesmo que <b>todos os ~${resto} votos válidos que faltam</b> fossem para os outros, ficaria com ${fmtPct(piso)} (> 50%).`}` };
  if (sit.segundoTurno) return { tipo: 'turno2', html: `🔄 <b>Haverá 2º turno</b> ${escopo}${final ? '' : ' — já é certo'}. ${final ? '' : `Mesmo que <b>todos os ~${resto} votos válidos que faltam</b> fossem para <b ${cor}>${l.nome}</b>, ele(a) chegaria a no máximo ${fmtPct(teto)} (< 50%).`}` };
  return null;
}
