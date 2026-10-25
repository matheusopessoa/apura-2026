// Servidor sem dependências:
//  - serve /public (páginas: /presidente e /gov-pe)
//  - /tse/*  : proxy para o TSE (evita CORS)
//  - grava um snapshot do resultado a cada 30 s (mesmo com o navegador fechado), um arquivo por turno:
//    1º turno em data/historico.jsonl, 2º turno em data/historico-2t.jsonl
//  - /api/historico, /api/snapshot?i=N, /api/historico.csv : consulta ao histórico gravado (?turno=1|2; padrão = turno atual)
//  - /api/municipios : resultado de Presidente por município (mapa 3D), relido quando o TSE publica arquivo novo
//  - /api/turno : turno em andamento. Muda sozinho para o 2º quando o TSE começa a totalizá-lo (ou force com TURNO=1|2)
//  - /api/calibracao : estimativa do 2º turno — prévia (1º turno + pesquisas) e curvas de correção aprendidas com o
//    1º turno encerrado (ver public/calibracao.js). Aceita as taxas de transferência na query (?renan=49.7,26.5&novos=38,46,20)
//  - 2º turno: grava a apuração de cada município a cada leitura em data/municipios-2t.jsonl (para replay);
//    /api/municipios/replay lista os momentos gravados e /api/municipios/replay?i=N devolve o mapa naquele momento
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carregarTSE, carregarMunicipiosTSE, ESTADOS, CANDIDATOS, TURNOS } from './public/data.js';
import { agregar, projetar } from './public/calc.js';
import { construirCalibracao } from './public/calibracao.js';
import { paramsDeQuery, chaveDe, paramsPadrao } from './public/transferencia.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, 'public');
const DATA_DIR = join(HERE, 'data');
const ARQS = {
  1: { hist: join(DATA_DIR, 'historico.jsonl'), mun: join(DATA_DIR, 'municipios.json') },
  2: { hist: join(DATA_DIR, 'historico-2t.jsonl'), mun: join(DATA_DIR, 'municipios-2t.json') },
};
const ARQ_ELEITORADO_1T = join(DATA_DIR, 'eleitorado-1t.json'); // eleitorado, comparecimento e abstenção por UF no 1º turno
const PORT = process.env.PORT || 3000;
const TSE = 'https://resultados.tse.jus.br/oficial';
const INTERVALO = 30_000;
const cache = new Map(); // cache curto (15 s) para não sobrecarregar o TSE
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

// ---------- histórico ----------
await mkdir(DATA_DIR, { recursive: true });
async function lerHistorico(t) {
  const out = [];
  try {
    for (const linha of (await readFile(ARQS[t].hist, 'utf8')).split('\n')) if (linha.trim()) out.push(JSON.parse(linha));
  } catch { /* primeiro uso */ }
  console.log(`Histórico ${t}º turno: ${out.length} snapshots (${ARQS[t].hist})`);
  return out;
}
const historicos = { 1: await lerHistorico(1), 2: await lerHistorico(2) };
// Turno: TURNO=1|2 força; senão começa no 2º se já houver gravação dele, e troca quando o TSE começar a totalizá-lo.
const TURNO_FIXO = Number(process.env.TURNO) || null;
let turno = TURNO_FIXO ?? (historicos[2].length ? 2 : 1);
let historico = historicos[turno];

// Abstenção final do 1º turno por UF (base dos "eleitores que não votaram no 1º turno" da estimativa do 2º).
// Os snapshots antigos não a têm; vem do arquivo final de acompanhamento do TSE, guardado em data/eleitorado-1t.json.
let eleitorado1 = {};
try { eleitorado1 = JSON.parse(await readFile(ARQ_ELEITORADO_1T, 'utf8')).ufs; }
catch {
  try {
    const e6 = TURNOS[1].padStart(6, '0');
    const ab = await (await fetch(`${TSE}/ele2026/${TURNOS[1]}/dados/br/br-e${e6}-ab.json`, { headers: { 'user-agent': 'Mozilla/5.0 painel-eleicoes' } })).json();
    for (const a of ab.abr) if (a.tpabr === 'uf') eleitorado1[a.cdabr.toUpperCase()] = { eleitorado: Number(a.e.te), comparecimento: Number(a.e.c), abstencao: Number(a.e.a) };
    await writeFile(ARQ_ELEITORADO_1T, JSON.stringify({ fonte: `resultados.tse.jus.br · 1º turno 2026 · arquivo ${ab.dg} ${ab.hg}`, ufs: eleitorado1 }, null, 1));
    console.log('Eleitorado do 1º turno lido do TSE e gravado em', ARQ_ELEITORADO_1T);
  } catch (err) { console.error('Sem abstenção do 1º turno (eleitores novos ficam de fora da prévia):', err.message); }
}
const hidratar = (snap) => snap.estados.map((e) => ({ ...ESTADOS.find((x) => x.uf === e.uf), abstencao1: eleitorado1[e.uf]?.abstencao, ...e }));
const resumo = (snap, i) => {
  const est = hidratar(snap);
  const a = agregar(est), p = agregar(est.map(projetar));
  return { i, t: snap.t, tse: snap.tse, apuracao: a.apuracao, validos: a.validos, atual: a.pct, proj: p.pct };
};

// ---------- estimativa do 2º turno (calibração aprendida com o 1º turno já encerrado + prévia das pesquisas) ----------
let calibracao = null;            // com as taxas padrão
const calibracoes = new Map();    // por conjunto de taxas (chaveDe → resultado), para as taxas editadas no painel
let snaps1 = null;                // snapshots do 1º turno hidratados (cache)
function montarCalibracao(params = paramsPadrao()) {
  const h = historicos[1];
  if (!h.length || h.at(-1).apuracao < 99.99) return null; // só com o resultado final do 1º turno
  const k = chaveDe(params);
  if (calibracoes.has(k)) return calibracoes.get(k);
  snaps1 ??= h.map(hidratar);
  const cal = construirCalibracao(snaps1, params);
  if (calibracoes.size > 50) calibracoes.clear();
  calibracoes.set(k, cal);
  if (!calibracao) { calibracao = cal; console.log(`Calibração: ${Object.keys(cal.ufs).length} estados, a partir de ${h.length} snapshots do 1º turno · prévia Brasil: Lula ${cal.previa.br.pLula.toFixed(2)}% × Flávio ${cal.previa.br.pFlavio.toFixed(2)}%`); }
  return cal;
}
montarCalibracao();

/** O 2º turno começou quando o arquivo nacional dele existe e já tem seções totalizadas. */
async function verificarSegundoTurno() {
  if (TURNO_FIXO || turno === 2) return;
  try {
    const e6 = TURNOS[2].padStart(6, '0');
    const r = await fetch(`${TSE}/ele2026/${TURNOS[2]}/dados/br/br-e${e6}-ab.json`, { headers: { 'user-agent': 'Mozilla/5.0 painel-eleicoes' } });
    if (!r.ok) return;
    const ab = await r.json();
    if (!(ab.abr ?? []).some((a) => Number(a.s?.st) > 0)) return;
    console.log('2º turno em totalização no TSE: trocando para o 2º turno');
    turno = 2; historico = historicos[2];
    trocarMunicipios();
  } catch { /* tenta de novo no próximo ciclo */ }
}

async function gravar() {
  await verificarSegundoTurno();
  const t = turno;
  try {
    const r = await carregarTSE(TSE, TURNOS[t]);
    const ultimo = historico.at(-1);
    if (ultimo && ultimo.tse === r.atualizadoTSE) return; // TSE ainda não publicou arquivo novo
    const apuracao = agregar(r.estados).apuracao;
    // O TSE às vezes serve um arquivo mais antigo (cache/CDN): ignora snapshots que andam para trás.
    if (ultimo && apuracao < ultimo.apuracao) { console.log(`ignorado: ${apuracao.toFixed(2)}% < ${ultimo.apuracao.toFixed(2)}% (arquivo TSE ${r.atualizadoTSE})`); return; }
    const snap = {
      t: new Date().toISOString(), tse: r.atualizadoTSE, apuracao,
      estados: r.estados.map(({ uf, eleitorado, eleitoradoApurado, comparecimento, abstencao, secoes, apuracao, votos }) => ({ uf, eleitorado, eleitoradoApurado, comparecimento, abstencao, secoes, apuracao, votos })),
    };
    historico.push(snap);
    await appendFile(ARQS[t].hist, JSON.stringify(snap) + '\n');
    if (t === 1 && snap.apuracao >= 99.99 && !calibracao) { snaps1 = null; montarCalibracao(); }
    console.log(`#${historico.length - 1} gravado · TSE ${snap.tse} · ${snap.apuracao.toFixed(2)}% apurado`);
    atualizarMunicipios(); // arquivo novo no TSE: relê os municípios (só baixa os que mudaram)
  } catch (err) {
    console.error('Falha ao gravar snapshot:', err.message);
  }
}

// ---------- municípios (mapa 3D) ----------
// Um arquivo de votos por município no TSE: a 1ª leitura baixa todos; depois só os que mudaram.
const mun = { lista: [], porCd: new Map(), tse: null, lidoEm: null, carregando: false, pendente: false, progresso: null, json: null };
async function lerCacheMunicipios() {
  Object.assign(mun, { lista: [], porCd: new Map(), tse: null, lidoEm: null, json: null });
  try {
    const salvo = JSON.parse(await readFile(ARQS[turno].mun, 'utf8'));
    mun.lista = salvo.lista; mun.tse = salvo.tse; mun.lidoEm = salvo.lidoEm;
    mun.porCd = new Map(mun.lista.map((m) => [m.cd, m]));
    console.log(`Municípios ${turno}º turno: ${mun.lista.length} carregados do cache`);
  } catch { /* primeiro uso */ }
}
await lerCacheMunicipios();
async function trocarMunicipios() { await lerCacheMunicipios(); atualizarMunicipios(); }

const IDS = CANDIDATOS.map((c) => c.id);
function respostaMunicipios() { // compacto: votos como array na ordem de CANDIDATOS
  const body = JSON.stringify({
    tse: mun.tse, lidoEm: mun.lidoEm, carregando: mun.carregando, progresso: mun.progresso, candidatos: IDS,
    municipios: mun.lista.map(({ cd, uf, ibge, nome, capital, eleitorado, eleitoradoApurado, secoes, votos }) =>
      [cd, uf, ibge, nome, capital ? 1 : 0, eleitorado, eleitoradoApurado, secoes.total, secoes.apuradas, IDS.map((id) => votos[id] || 0)]),
  });
  return { body: Buffer.from(body), gz: gzipSync(body) };
}

// ---------- gravação por município (replay do 2º turno) ----------
// Uma linha por leitura com mudança: { t, tse, apuracao, fixos?, m }. A 1ª linha traz todos os municípios;
// as seguintes, só os que mudaram. fixos: [cd, uf, ibge, nome, capital, eleitorado, total de seções] (dados que não mudam);
// m: [cd, seções apuradas, eleitorado apurado, votos na ordem de `candidatos`].
const ARQ_REPLAY = join(DATA_DIR, 'municipios-2t.jsonl');
const replay = { linhas: [], estado: new Map(), fixos: new Map() }; // estado/fixos = situação após a última linha
try {
  for (const l of (await readFile(ARQ_REPLAY, 'utf8')).split('\n')) if (l.trim()) aplicarLinhaReplay(JSON.parse(l));
  console.log(`Replay municipal 2º turno: ${replay.linhas.length} momentos gravados`);
} catch { /* ainda não começou */ }
function aplicarLinhaReplay(linha, alvo = replay) {
  for (const f of linha.fixos ?? []) alvo.fixos.set(f[0], f);
  for (const x of linha.m) alvo.estado.set(x[0], x);
  if (alvo === replay) replay.linhas.push(linha);
}
async function gravarReplay(lista) {
  const m = [], fixos = [];
  for (const x of lista) {
    if (x.versao === 'erro') continue; // leitura falhou: grava quando vier o dado de verdade
    const reg = [x.cd, x.secoes.apuradas, x.eleitoradoApurado, IDS.map((id) => x.votos[id] || 0)];
    if (JSON.stringify(replay.estado.get(x.cd)) === JSON.stringify(reg)) continue; // não mudou desde a última linha
    m.push(reg);
    if (!replay.fixos.has(x.cd)) fixos.push([x.cd, x.uf, x.ibge, x.nome, x.capital ? 1 : 0, x.eleitorado, x.secoes.total]);
  }
  if (!m.length) return;
  const linha = { t: new Date().toISOString(), tse: historicos[2].at(-1)?.tse ?? null, apuracao: historicos[2].at(-1)?.apuracao ?? null,
    candidatos: IDS, ...(fixos.length && { fixos }), m };
  await appendFile(ARQ_REPLAY, JSON.stringify(linha) + '\n');
  aplicarLinhaReplay(linha);
  console.log(`Replay municipal: momento #${replay.linhas.length - 1} · ${m.length} município(s) mudaram`);
}
/** Mapa municipal no momento i (mesmo formato de /api/municipios). */
function momentoReplay(i) {
  const alvo = { estado: new Map(), fixos: new Map() };
  for (const linha of replay.linhas.slice(0, i + 1)) aplicarLinhaReplay(linha, alvo);
  const linha = replay.linhas[i];
  return { tse: linha.tse, lidoEm: linha.t, apuracao: linha.apuracao, candidatos: linha.candidatos, replay: i,
    municipios: [...alvo.estado.values()].map(([cd, sa, ea, v]) => {
      const [, uf, ibge, nome, capital, eleitorado, ts] = alvo.fixos.get(cd);
      return [cd, uf, ibge, nome, capital, eleitorado, ea, ts, sa, v];
    }) };
}

async function atualizarMunicipios() {
  if (mun.carregando) { mun.pendente = true; return; } // chegou arquivo novo durante a leitura: relê ao terminar
  mun.carregando = true; mun.pendente = false; mun.json = null;
  const t = turno;
  try {
    const r = await carregarMunicipiosTSE(TSE, mun.porCd, { eleicao: TURNOS[t], progresso: (f, tot) => { mun.progresso = { feitos: f, total: tot }; mun.json = null; } });
    if (t !== turno) return; // o turno mudou durante a leitura
    mun.lista = r.municipios; mun.porCd = new Map(r.municipios.map((m) => [m.cd, m]));
    mun.lidoEm = new Date().toISOString();
    mun.tse = historico.at(-1)?.tse ?? mun.tse;
    if (t === 2) await gravarReplay(mun.lista);
    if (r.baixados) {
      await writeFile(ARQS[t].mun, JSON.stringify({ tse: mun.tse, lidoEm: mun.lidoEm, lista: mun.lista }));
      console.log(`Municípios: ${r.baixados} arquivo(s) novo(s) do TSE · ${mun.lista.length} municípios`);
    }
  } catch (err) {
    console.error('Falha ao ler municípios:', err.message);
  } finally {
    mun.carregando = false; mun.progresso = null; mun.json = null;
    if (mun.pendente) atualizarMunicipios();
  }
}
atualizarMunicipios(); // uma vez ao iniciar; depois, só quando gravar() encontra arquivo novo do TSE
gravar();
setInterval(gravar, INTERVALO);

/** Para cada percentil inteiro de apuração geral, o primeiro snapshot que o alcançou. */
function percentis(historico) {
  const out = [];
  for (let p = 1; p <= 100; p++) {
    const i = historico.findIndex((s) => s.apuracao >= p);
    if (i < 0) break;
    if (out.at(-1)?.i === i) continue; // mesmo snapshot cobre vários percentis (ex.: gravação começou em 28%)
    out.push({ ...resumo(historico[i], i), p: Math.floor(historico[i].apuracao) });
  }
  const n = historico.length - 1;
  if (n >= 0 && out.at(-1)?.i !== n) out.push({ ...resumo(historico[n], n), p: Number(historico[n].apuracao.toFixed(2)) }); // momento mais recente
  return out;
}

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const tq = Number(url.searchParams.get('turno'));
    const historico = historicos[tq === 1 || tq === 2 ? tq : turno];
    if (url.pathname === '/api/turno') return json(res, { turno, eleicao: TURNOS[turno], calibracao: !!calibracao });
    if (url.pathname === '/api/calibracao') {
      const cal = calibracao && montarCalibracao(paramsDeQuery(url.searchParams));
      return cal ? json(res, cal) : json(res, { erro: 'calibração indisponível (1º turno sem resultado final gravado)' }, 404);
    }
    if (url.pathname === '/api/historico') {
      const n = historico.length;
      return json(res, { turno: historico === historicos[1] ? 1 : 2, total: n, ultimo: n ? resumo(historico[n - 1], n - 1) : null, percentis: percentis(historico) });
    }
    if (url.pathname === '/api/snapshot') {
      const i = Number(url.searchParams.get('i'));
      if (!historico[i]) return json(res, { erro: 'snapshot inexistente' }, 404);
      return json(res, { ...resumo(historico[i], i), estados: hidratar(historico[i]) });
    }
    if (url.pathname === '/api/municipios/replay') {
      const i = url.searchParams.get('i');
      if (i === null) return json(res, { turno: 2, momentos: replay.linhas.map((l, k) => ({ i: k, t: l.t, tse: l.tse, apuracao: l.apuracao, mudaram: l.m.length })) });
      if (!replay.linhas[+i]) return json(res, { erro: 'momento inexistente' }, 404);
      const body = JSON.stringify(momentoReplay(+i));
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz && { 'content-encoding': 'gzip' }) });
      return res.end(gz ? gzipSync(body) : body);
    }
    if (url.pathname === '/api/municipios') {
      mun.json ??= respostaMunicipios();
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(gz && { 'content-encoding': 'gzip' }) });
      return res.end(gz ? mun.json.gz : mun.json.body);
    }
    if (url.pathname === '/api/historico.csv') {
      const cols = CANDIDATOS.flatMap((c) => [`atual_${c.nome}`, `proj_${c.nome}`]);
      const linhas = percentis(historico).map((r) => [r.p, r.apuracao.toFixed(2), r.tse, r.t,
        ...CANDIDATOS.flatMap((c) => [r.atual[c.id].toFixed(3), r.proj[c.id].toFixed(3)])].join(';'));
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="historico-por-percentil.csv"' });
      return res.end('﻿' + [['percentil', 'apuracao_real', 'arquivo_tse', 'gravado_em', ...cols].join(';'), ...linhas].join('\n'));
    }
    if (url.pathname.startsWith('/tse/')) {
      const hit = cache.get(url.pathname);
      if (hit && Date.now() - hit.t < 15000) { res.writeHead(hit.status, hit.h); return res.end(hit.body); }
      const r = await fetch(`${TSE}/${url.pathname.slice(5)}${url.search}`, { headers: { 'user-agent': 'Mozilla/5.0 painel-eleicoes' } });
      const body = Buffer.from(await r.arrayBuffer());
      const h = { 'content-type': 'application/json', 'cache-control': 'no-store' };
      if (r.ok) cache.set(url.pathname, { t: Date.now(), status: r.status, h, body });
      res.writeHead(r.status, h);
      return res.end(body);
    }
    if (url.pathname === '/') { res.writeHead(302, { location: '/presidente' }); return res.end(); }
    const PAGINAS = { '/presidente': '/index.html', '/gov-pe': '/gov-pe.html' };
    const rel = normalize(PAGINAS[url.pathname.replace(/\/$/, '')] ?? url.pathname);
    if (rel.includes('..')) throw new Error('bad path');
    let body = await readFile(join(ROOT, rel));
    const h = { 'content-type': MIME[extname(rel)] || 'application/octet-stream' };
    if (body.length > 64_000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); h['content-encoding'] = 'gzip'; }
    res.writeHead(200, h);
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`Painel em http://localhost:${PORT}`));
