// Dados-base e leitura da API pública de resultados do TSE (1º turno 2026, Presidente).

export const TSE = { ciclo: 'ele2026', eleicao: '6257', cargo: '0001' };
// Código da eleição de Presidente em cada turno (comum/config/ele-c.json do TSE: 6257 → cdt2 6258).
export const TURNOS = { 1: '6257', 2: '6258' };

// Candidatos oficiais (registro no TSE). `destaque`: aparece na legenda, nos KPIs e nas colunas da tabela.
const C = (numero, nome, partido, cor, destaque = false) => ({ id: String(numero), numero, nome, partido, cor, destaque });
export const CANDIDATOS = [
  C(13, 'Lula', 'PT', '#e63946', true),
  C(22, 'Flávio Bolsonaro', 'PL', '#2563eb', true),
  C(55, 'Ronaldo Caiado', 'PSD', '#f59e0b', true),
  C(30, 'Romeu Zema', 'NOVO', '#0d9488', true),
  C(14, 'Renan Santos', 'MISSÃO', '#db2777', true),
  C(70, 'Augusto Cury', 'AVANTE', '#7c3aed', true),
  C(80, 'Samara', 'UP', '#65a30d'),
  C(27, 'Clariana Barão', 'DC', '#94a3b8'),
  C(16, 'Hertz Dias', 'PSTU', '#a8a29e'),
  C(21, 'Edmilson Costa', 'PCB', '#78716c'),
  C(35, 'Wilson Grassi', 'DEMOCRATA', '#0ea5e9'),
  C(29, 'Rui Costa Pimenta', 'PCO', '#c2410c'),
];

export const REGIOES = {
  N:  { nome: 'Norte' },
  NE: { nome: 'Nordeste' },
  CO: { nome: 'Centro-Oeste' },
  SE: { nome: 'Sudeste' },
  S:  { nome: 'Sul' },
  EX: { nome: 'Exterior' },
};

// col/row: posição no mapa de blocos. O eleitorado vem do TSE em tempo real.
export const ESTADOS = [
  ['AC','Acre','N',1,2], ['AP','Amapá','N',5,0], ['AM','Amazonas','N',2,1], ['PA','Pará','N',4,1],
  ['RO','Rondônia','N',2,2], ['RR','Roraima','N',3,0], ['TO','Tocantins','N',4,2],
  ['AL','Alagoas','NE',6,3], ['BA','Bahia','NE',5,3], ['CE','Ceará','NE',6,1], ['MA','Maranhão','NE',5,1],
  ['PB','Paraíba','NE',7,2], ['PE','Pernambuco','NE',6,2], ['PI','Piauí','NE',5,2],
  ['RN','Rio Grande do Norte','NE',7,1], ['SE','Sergipe','NE',6,4],
  ['DF','Distrito Federal','CO',4,4], ['GO','Goiás','CO',4,3], ['MT','Mato Grosso','CO',3,2], ['MS','Mato Grosso do Sul','CO',3,3],
  ['ES','Espírito Santo','SE',6,5], ['MG','Minas Gerais','SE',5,4], ['RJ','Rio de Janeiro','SE',5,5], ['SP','São Paulo','SE',4,5],
  ['PR','Paraná','S',4,6], ['SC','Santa Catarina','S',4,7], ['RS','Rio Grande do Sul','S',4,8],
  ['ZZ','Exterior','EX',7,8],
].map(([uf, nome, regiao, col, row]) => ({ uf, nome, regiao, col, row }));

const num = (v) => Number(v) || 0;

async function getJson(origem, path, eleicao = TSE.eleicao) {
  const r = await fetch(`${origem}/${TSE.ciclo}/${eleicao}/dados/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
  return r.json();
}

/** Lê o acompanhamento (seções + eleitorado) e os votos de cada UF. */
/** `origem`: '/tse' (proxy local, no navegador) ou a URL oficial (no servidor). */
/** `eleicao`: código da eleição no TSE (TURNOS[1] ou TURNOS[2]). */
export async function carregarTSE(origem = '/tse', eleicao = TSE.eleicao) {
  const e6 = eleicao.padStart(6, '0');
  const [ab, ...us] = await Promise.all([
    getJson(origem, `br/br-e${e6}-ab.json`, eleicao),
    ...ESTADOS.map((e) => {
      const u = e.uf.toLowerCase();
      return getJson(origem, `${u}/${u}-c${TSE.cargo}-e${e6}-u.json`, eleicao);
    }),
  ]);

  const estados = ESTADOS.map((e, i) => {
    const abr = ab.abr.find((a) => a.cdabr === e.uf.toLowerCase());
    if (!abr) throw new Error(`Sem acompanhamento para ${e.uf}`);
    const votos = Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
    for (const agr of us[i].carg?.[0]?.agr ?? [])
      for (const par of agr.par ?? [])
        for (const c of par.cand ?? []) if (c.n in votos) votos[c.n] += num(c.vap);
    const ts = num(abr.s.ts), st = num(abr.s.st);
    return { ...e, eleitorado: num(abr.e.te), eleitoradoApurado: num(abr.e.est), secoes: { total: ts, apuradas: st }, apuracao: ts ? (st / ts) * 100 : 0, votos };
  });
  return { estados, atualizadoTSE: `${ab.dg} ${ab.hg}` };
}

const titulo = (t) => t.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/ (De|Da|Do|Dos|Das|E) /g, (m) => m.toLowerCase());
const votosDoArquivo = (u) => {
  const votos = Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
  for (const agr of u?.carg?.[0]?.agr ?? [])
    for (const par of agr.par ?? [])
      for (const c of par.cand ?? []) if (c.n in votos) votos[c.n] += num(c.vap);
  return votos;
};

/**
 * Resultado de Presidente por MUNICÍPIO (unidade do mapa 3D). Mesmo formato de unidade que `carregarTSE`
 * (eleitorado, eleitoradoApurado, secoes, apuracao, votos), mais identificação do município.
 * `anterior`: Map cd → município da leitura anterior; só baixa de novo o arquivo de votos de quem mudou
 * (o TSE publica um arquivo por município, ~5.570 no total). Exterior (ZZ) fica de fora: não tem geografia.
 */
export async function carregarMunicipiosTSE(origem = '/tse', anterior = new Map(), { eleicao = TSE.eleicao, concorrencia = 6, progresso } = {}) {
  const e6 = eleicao.padStart(6, '0');
  const ufs = ESTADOS.filter((e) => e.uf !== 'ZZ');
  if (!cadastro) { // nomes e códigos IBGE não mudam durante a apuração: lê uma vez só
    const cfg = await comRetentativa(() => getJsonAbs(origem, `config/mun-e${e6}-cm.json`, eleicao));
    cadastro = new Map();
    for (const a of cfg.abr) for (const m of a.mu) cadastro.set(m.cd, { ibge: m.cdi, nome: titulo(m.nm), capital: m.c === 's' });
  }
  const info = cadastro;
  const abs = [];
  for (const e of ufs) { const u = e.uf.toLowerCase(); abs.push(await comRetentativa(() => getJson(origem, `${u}/${u}-e${e6}-ab.json`, eleicao))); }

  const lista = [];
  ufs.forEach((e, i) => {
    for (const a of abs[i].abr) if (a.tpabr === 'mun') lista.push({ uf: e.uf, a });
  });

  const out = new Array(lista.length);
  const pendentes = [];
  lista.forEach(({ uf, a }, i) => {
    const ts = num(a.s.ts), st = num(a.s.st);
    const versao = `${a.dt} ${a.ht} ${st}`;
    const m = { cd: a.cdabr, uf, ...info.get(a.cdabr), eleitorado: num(a.e.te), eleitoradoApurado: num(a.e.est),
      secoes: { total: ts, apuradas: st }, apuracao: ts ? (st / ts) * 100 : 0, versao };
    const prev = anterior.get(a.cdabr);
    if (prev && prev.versao === versao) m.votos = prev.votos;
    else if (st === 0) m.votos = Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
    else pendentes.push(i);
    out[i] = m;
  });

  let prox = 0, feitos = 0;
  const worker = async () => {
    while (prox < pendentes.length) {
      const i = pendentes[prox++];
      const m = out[i], u = m.uf.toLowerCase();
      try {
        m.votos = votosDoArquivo(await comRetentativa(() => getJson(origem, `${u}/${u}${m.cd}-c${TSE.cargo}-e${e6}-u.json`, eleicao)));
      } catch {
        const prev = anterior.get(m.cd); // falhou agora: mantém a leitura anterior (ou zera) e tenta de novo na próxima
        m.votos = prev?.votos ?? Object.fromEntries(CANDIDATOS.map((c) => [c.id, 0]));
        m.versao = prev?.versao ?? 'erro';
      }
      if (progresso && ++feitos % 200 === 0) progresso(feitos, pendentes.length);
    }
  };
  await Promise.all(Array.from({ length: concorrencia }, worker));
  return { municipios: out, baixados: pendentes.length };
}

let cadastro = null;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
/** O TSE limita requisições (HTTP 429): espera e tenta de novo, com intervalo crescente. */
async function comRetentativa(fn, tentativas = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) { if (i >= tentativas || !/HTTP (429|5\d\d)/.test(err.message)) throw err; await espera(1500 * 2 ** i); }
  }
}

async function getJsonAbs(origem, path, eleicao = TSE.eleicao) {
  const r = await fetch(`${origem}/${TSE.ciclo}/${eleicao}/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
  return r.json();
}
