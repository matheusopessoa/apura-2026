// Gera public/geo/municipios.json a partir da malha oficial do IBGE (5.570 municípios, qualidade mínima).
// Uso: node scripts/gerar-geo.mjs
// Saída: { escala, municipios: { <código IBGE>: [ polígono: [ anel: [x0, y0, x1, y1, ...] ] ] } }
// Coordenadas = lon/lat × escala, arredondadas para inteiro (escala 1e4 ≈ 11 m, a malha mínima já é mais grossa).
import { writeFile, mkdir } from 'node:fs/promises';

const URL_IBGE = 'https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR?formato=application/vnd.geo%2Bjson&qualidade=minima&intrarregiao=municipio';
const ESCALA = 1e4;

const r = await fetch(URL_IBGE);
if (!r.ok) throw new Error(`IBGE respondeu HTTP ${r.status}`);
const geo = await r.json();

const municipios = {};
for (const f of geo.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  municipios[f.properties.codarea] = polys.map((aneis) => aneis.map((anel) => {
    const out = [];
    for (const [lon, lat] of anel.slice(0, -1)) { // último ponto repete o primeiro
      const x = Math.round(lon * ESCALA), y = Math.round(lat * ESCALA);
      if (out.length && out.at(-2) === x && out.at(-1) === y) continue;
      out.push(x, y);
    }
    return out;
  }).filter((a) => a.length >= 6));
}

await mkdir(new URL('../public/geo/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/geo/municipios.json', import.meta.url), JSON.stringify({ escala: ESCALA, municipios }));
console.log(`${Object.keys(municipios).length} municípios gravados em public/geo/municipios.json`);
