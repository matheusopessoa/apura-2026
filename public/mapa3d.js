// Mapa 3D municipal: cada município do IBGE é um prisma extrudado a partir do seu polígono real.
//   COR    = candidato que lidera no município (definida por quem chama)
//   ALTURA = % de seções apuradas no município (linear: 0% ≈ plano, 100% = ALT_MAX)
// Altura e cor ficam em texturas (1 texel por município) lidas no vertex shader: atualizar os dados
// custa ~5.570 valores, e a transição de altura é animada na GPU.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const LON0 = -53.2, LAT0 = -14.6, KX = Math.cos((LAT0 * Math.PI) / 180);
export const ALT_MIN = 0.035, ALT_MAX = 2.6;     // em "graus" do mapa: escala vertical exagerada de propósito
const BASE = 0.55;                               // espessura do pedestal sob o país
export const alturaDe = (pct) => ALT_MIN + (ALT_MAX - ALT_MIN) * Math.min(1, Math.max(0, pct / 100));
const COR_SEM_DADOS = '#1b2742';

const projetar = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0)]; // x, z (z+ = sul, câmera olha para o norte)

const SHADER_TOPO = /* glsl */`
attribute float aMuni;
attribute float aKind; // 0 = topo, 1 = parede (alto), 2 = parede (base)
uniform sampler2D uAlt; uniform sampler2D uCor; uniform vec2 uTam; uniform float uT;
vec2 texelMuni() { return (vec2(mod(aMuni, uTam.x), floor(aMuni / uTam.x)) + 0.5) / uTam; }
float alturaMuni() { vec4 a = texture2D(uAlt, texelMuni()); return mix(a.r, a.g, uT); }
`;

function aplicarAltura(material, uniforms, { cor = false, delta = 0 } = {}) {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${SHADER_TOPO}${cor ? 'varying vec3 vCorMun; varying float vMuni; varying float vFora; uniform float uFoco;' : ''}`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
        if (aKind < 1.5) transformed.y = alturaMuni() + ${delta.toFixed(4)};
        ${cor ? `vec4 cm = texture2D(uCor, texelMuni());
          vCorMun = cm.rgb * (aKind < 0.5 ? 1.0 : aKind < 1.5 ? 0.84 : 0.30); vMuni = aMuni;
          vFora = (uFoco > 0.0 && abs(cm.a - uFoco) > 0.5) ? 1.0 : 0.0;` : ''}`);
    if (cor) sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCorMun; varying float vMuni; varying float vFora; uniform float uHover; uniform float uDim;')
      .replace('#include <color_fragment>', `diffuseColor.rgb *= vCorMun;
        if (abs(vMuni - uHover) < 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.30);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.022, 0.05), vFora * uDim);`);
  };
}

/** Constrói prismas (topo + paredes), contornos municipais, divisas estaduais e o pedestal. */
function construir(geo) {
  const codigos = Object.keys(geo.municipios);
  const k = 1 / geo.escala;
  const pts = codigos.map((cd) => geo.municipios[cd].map((aneis) => aneis.map((a) => {
    const out = [];
    for (let i = 0; i < a.length; i += 2) out.push(projetar(a[i] * k, a[i + 1] * k));
    return out;
  })));

  // arestas compartilhadas (a malha do IBGE tem topologia comum): divisas e contorno do país
  const chave = (cd, ring, i) => {
    const a = geo.municipios[cd][ring[0]][ring[1]], n = a.length / 2, j = (i + 1) % n;
    const p = `${a[2 * i]},${a[2 * i + 1]}`, q = `${a[2 * j]},${a[2 * j + 1]}`;
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  const arestas = new Map();
  codigos.forEach((cd, m) => geo.municipios[cd].forEach((aneis, pi) => aneis.forEach((a, ri) => {
    for (let i = 0; i < a.length / 2; i++) {
      const key = chave(cd, [pi, ri], i);
      const v = arestas.get(key);
      if (v) v.push(m); else arestas.set(key, [m]);
    }
  })));
  const ufDe = (m) => codigos[m].slice(0, 2);

  const pos = [], nor = [], muni = [], kind = [];
  const ligado = new Uint8Array(codigos.length); // tem divisa com outro município do mesmo estado (ilhas não têm)
  const lin = [], linM = [], div = [], divM = [];
  const ped = [], pedN = [], pedC = [];
  const centro = new Array(codigos.length);
  const push = (x, z, nx, nz, m, kd) => { pos.push(x, 0, z); nor.push(nx, kd === 0 ? 1 : 0, nz); muni.push(m); kind.push(kd); };

  pts.forEach((polys, m) => {
    let areaMax = -1;
    polys.forEach((aneis, pi) => {
      // topo
      const contorno = aneis[0].map(([x, z]) => new THREE.Vector2(x, z));
      const furos = aneis.slice(1).map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
      const todos = [contorno, ...furos].flat();
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contorno, furos)) {
        const A = todos[a], B = todos[b], C = todos[c];
        const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0;
        for (const P of up ? [A, B, C] : [A, C, B]) push(P.x, P.y, 0, 0, m, 0);
      }
      // centro (do maior polígono) para as chamadas
      const area = Math.abs(THREE.ShapeUtils.area(contorno));
      if (area > areaMax) {
        areaMax = area;
        let cx = 0, cz = 0; for (const [x, z] of aneis[0]) { cx += x; cz += z; }
        centro[m] = [cx / aneis[0].length, cz / aneis[0].length];
      }
      // paredes, contornos e pedestal
      aneis.forEach((r, ri) => {
        let s = 0; for (let i = 0; i < r.length; i++) { const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % r.length]; s += x1 * z2 - x2 * z1; }
        const sinal = (s > 0 ? 1 : -1) * (ri > 0 ? -1 : 1); // normal externa = sinal × (dz, -dx)
        for (let i = 0; i < r.length; i++) {
          const [px, pz] = r[i], [qx, qz] = r[(i + 1) % r.length];
          const dx = qx - px, dz = qz - pz, L = Math.hypot(dx, dz) || 1;
          const nx = (sinal * dz) / L, nz = (-sinal * dx) / L;
          const quad = sinal < 0
            ? [[px, pz, 2], [qx, qz, 2], [qx, qz, 1], [px, pz, 2], [qx, qz, 1], [px, pz, 1]]
            : [[px, pz, 2], [qx, qz, 1], [qx, qz, 2], [px, pz, 2], [px, pz, 1], [qx, qz, 1]];
          for (const [x, z, kd] of quad) push(x, z, nx, nz, m, kd);
          lin.push(px, 0, pz, qx, 0, qz); linM.push(m, m);
          const viz = arestas.get(chave(codigos[m], [pi, ri], i));
          const borda = viz.length === 1;
          if (!ligado[m] && viz.some((o) => o !== m && ufDe(o) === ufDe(m))) ligado[m] = 1;
          if (borda || viz.some((o) => ufDe(o) !== ufDe(m))) { div.push(px, 0, pz, qx, 0, qz); divM.push(m, m); }
          if (borda) { // pedestal: parede escura de y = 0 até -BASE no contorno do país
            const t = [[px, pz, 0], [qx, qz, 0], [qx, qz, -BASE], [px, pz, 0], [qx, qz, -BASE], [px, pz, -BASE]];
            const quadP = sinal < 0 ? [t[2], t[1], t[0], t[5], t[4], t[3]] : t;
            for (const [x, z, y] of quadP) { ped.push(x, y, z); pedN.push(nx, 0, nz); const c = y === 0 ? 0.16 : 0.035; pedC.push(c * 0.55, c * 0.75, c * 1.25); }
          }
        }
      });
    });
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aMuni', new THREE.Float32BufferAttribute(muni, 1));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  const linha = (p, m) => {
    const l = new THREE.BufferGeometry();
    l.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    l.setAttribute('aMuni', new THREE.Float32BufferAttribute(m, 1));
    l.setAttribute('aKind', new THREE.Float32BufferAttribute(new Float32Array(m.length), 1));
    return l;
  };
  const gp = new THREE.BufferGeometry();
  gp.setAttribute('position', new THREE.Float32BufferAttribute(ped, 3));
  gp.setAttribute('normal', new THREE.Float32BufferAttribute(pedN, 3));
  gp.setAttribute('color', new THREE.Float32BufferAttribute(pedC, 3));
  // caixa (x, z) de cada estado, para enquadrar a câmera. Ilhas distantes (ex.: Fernando de Noronha) ficam de fora;
  // estado de um município só (DF) usa o próprio município.
  const caixas = new Map();
  for (const soLigados of [true, false]) pts.forEach((polys, m) => {
    const uf = codigos[m].slice(0, 2);
    if (soLigados ? !ligado[m] : caixas.has(uf)) return;
    const c = caixas.get(uf) ?? [Infinity, -Infinity, Infinity, -Infinity];
    for (const aneis of polys) for (const [x, z] of aneis[0]) { c[0] = Math.min(c[0], x); c[1] = Math.max(c[1], x); c[2] = Math.min(c[2], z); c[3] = Math.max(c[3], z); }
    caixas.set(uf, c);
  });
  return { codigos, pts, centro, caixas, prismas: g, contornos: linha(lin, linM), divisas: linha(div, divM), pedestal: gp };
}

/**
 * Cria o mapa em `el`. Retorna { atualizar(dados), destaques(lista) }.
 * dados: Map código IBGE → { cor: '#hex', apuracao: 0–100 } (ausente = sem dados).
 */
export async function criarMapa3D(el, { geoUrl, aoPassar, aoClicar, aoClicarEstado, bussola, reservaDireita = () => 0 } = {}) {
  const geo = await (await fetch(geoUrl)).json();
  const { codigos, pts, centro, caixas, prismas, contornos, divisas, pedestal } = construir(geo);
  const indice = new Map(codigos.map((c, i) => [c, i]));
  const munisDoUf = new Map();
  codigos.forEach((c, i) => { const uf = c.slice(0, 2); if (!munisDoUf.has(uf)) munisDoUf.set(uf, []); munisDoUf.get(uf).push(i); });
  const N = codigos.length, TW = 128, TH = Math.ceil(N / TW);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  el.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // texturas por município: alt (r = altura anterior, g = altura nova), cor (rgb linear)
  const altData = new Float32Array(TW * TH * 4), corData = new Float32Array(TW * TH * 4);
  const c0 = new THREE.Color(COR_SEM_DADOS);
  // alfa da textura de cor = código IBGE do estado (2 dígitos), usado para escurecer quem está fora do foco
  for (let i = 0; i < N; i++) { altData[i * 4] = altData[i * 4 + 1] = ALT_MIN; corData.set([c0.r, c0.g, c0.b, Number(codigos[i].slice(0, 2))], i * 4); }
  const texAlt = new THREE.DataTexture(altData, TW, TH, THREE.RGBAFormat, THREE.FloatType);
  const texCor = new THREE.DataTexture(corData, TW, TH, THREE.RGBAFormat, THREE.FloatType);
  texAlt.needsUpdate = texCor.needsUpdate = true;
  const uniforms = { uAlt: { value: texAlt }, uCor: { value: texCor }, uTam: { value: new THREE.Vector2(TW, TH) }, uT: { value: 1 }, uHover: { value: -1 }, uFoco: { value: -1 }, uDim: { value: 0 } };

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.48, metalness: 0.0, envMapIntensity: 0.16 });
  aplicarAltura(mat, uniforms, { cor: true });
  const malha = new THREE.Mesh(prismas, mat);
  malha.castShadow = malha.receiveShadow = true;
  malha.frustumCulled = false;
  malha.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  aplicarAltura(malha.customDepthMaterial, uniforms);
  scene.add(malha);

  const matLin = new THREE.LineBasicMaterial({ color: 0x050a18, transparent: true, opacity: 0.26 });
  aplicarAltura(matLin, uniforms, { delta: 0.002 });
  const lin = new THREE.LineSegments(contornos, matLin); lin.frustumCulled = false; scene.add(lin);
  const matDiv = new THREE.LineBasicMaterial({ color: 0xd6e0f7, transparent: true, opacity: 0.5 });
  aplicarAltura(matDiv, uniforms, { delta: 0.004 });
  const dv = new THREE.LineSegments(divisas, matDiv); dv.frustumCulled = false; scene.add(dv);

  const ped = new THREE.Mesh(pedestal, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }));
  ped.receiveShadow = true; scene.add(ped);

  const chao = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.45 }));
  chao.rotation.x = -Math.PI / 2; chao.position.y = -BASE - 0.001; chao.receiveShadow = true; scene.add(chao);

  // luz: céu frio suave + luz principal discreta do alto/oeste (ilumina topos e faces voltadas à câmera; sombras para nordeste)
  scene.add(new THREE.HemisphereLight(0xa9bcef, 0x060b1a, 0.48));
  const sol = new THREE.DirectionalLight(0xfff4e6, 1.35);
  sol.position.set(-18, 30, 12);
  sol.castShadow = true;
  sol.shadow.mapSize.set(4096, 4096);
  Object.assign(sol.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 90 });
  sol.shadow.bias = -0.0004; sol.shadow.normalBias = 0.015; sol.shadow.radius = 3;
  scene.add(sol, sol.target);
  const fill = new THREE.DirectionalLight(0x8fa8ff, 0.35); fill.position.set(22, 12, 26); scene.add(fill);

  // câmera oblíqua (vista do sul, norte para cima)
  const camera = new THREE.PerspectiveCamera(26, 1, 0.5, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(-1.2, 0, -0.2);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.15; controls.maxPolarAngle = 1.12;
  controls.minAzimuthAngle = -0.9; controls.maxAzimuthAngle = 0.9;
  controls.screenSpacePanning = false; controls.zoomSpeed = 0.8;
  // a roda do mouse rola a página; zoom só com ⌘/Ctrl + roda (ou pinça no trackpad, que chega como ctrl + roda)
  el.addEventListener('wheel', (ev) => { controls.enableZoom = ev.ctrlKey || ev.metaKey; }, { capture: true, passive: true });
  // no toque, um dedo rola a página; dois dedos giram/aproximam o mapa
  renderer.domElement.style.touchAction = 'pan-y';
  controls.touches.ONE = null; controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

  let w = 1, h = 1;
  let foco = null;           // { uf } quando a visão está num estado
  let voo = null;            // animação de câmera em andamento
  const vfov = () => (camera.fov * Math.PI) / 180;
  const vistaBrasil = () => {
    const tv = Math.tan(vfov() / 2), th = tv * camera.aspect;
    return { alvo: new THREE.Vector3(-1.2, 0, -0.2), r: Math.max(17.5 / tv, (w < 760 ? 19.6 : 21) / th), phi: 0.72, theta: 0 };
  };
  /** Enquadra o estado na área livre do mapa (à esquerda do painel lateral, se houver). */
  const alturaMediaUf = (uf) => { const ms = munisDoUf.get(uf) ?? []; return ms.length ? ms.reduce((t, m) => t + altAtual(m), 0) / ms.length : 0; };
  const vistaEstado = (uf) => {
    const [x0, x1, z0, z1] = caixas.get(uf);
    const painel = Math.min(reservaDireita() || 0, w * 0.6), livre = w - painel;
    const phi = 0.66, tv = Math.tan(vfov() / 2), th = tv * camera.aspect * (livre / w);
    const sx = Math.max(x1 - x0, 0.6), sz = Math.max(z1 - z0, 0.6);
    const ext = sz * Math.cos(phi) + ALT_MAX * Math.sin(phi);
    const r = Math.max(ext / 2 / tv, sx / 2 / th) * 1.4 + ALT_MAX * 0.6;
    const desloc = (painel / w) * r * tv * camera.aspect; // centro do estado no meio da área livre
    // mira na altura média atual dos municípios do estado (é onde está a superfície visível)
    const y = alturaMediaUf(uf);
    return { alvo: new THREE.Vector3((x0 + x1) / 2 + desloc, y, (z0 + z1) / 2), r, phi, theta: 0 };
  };
  const esf = new THREE.Spherical(), vtmp = new THREE.Vector3();
  const aplicarVista = (v) => {
    controls.target.copy(v.alvo);
    camera.position.copy(v.alvo).add(vtmp.setFromSpherical(esf.set(v.r, v.phi, v.theta)));
    controls.update(); sujo = true;
  };
  const voarPara = (v, dur = 1400) => {
    esf.setFromVector3(vtmp.copy(camera.position).sub(controls.target));
    voo = { t0: performance.now(), dur, de: { alvo: controls.target.clone(), r: esf.radius, phi: esf.phi, theta: esf.theta }, para: v };
    controls.enabled = false;
  };
  const passoVoo = (agora) => {
    const t = Math.min(1, (agora - voo.t0) / voo.dur), e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const { de, para } = voo;
    aplicarVista({ alvo: vtmp.clone().lerpVectors(de.alvo, para.alvo, e), r: de.r * (para.r / de.r) ** e,
      phi: de.phi + (para.phi - de.phi) * e, theta: de.theta + (para.theta - de.theta) * e });
    if (t >= 1) { voo = null; controls.enabled = true; }
  };
  const enquadrar = () => {
    w = el.clientWidth; h = el.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    for (const m of [matDest, matGlow]) m.resolution.set(w, h);
    const b = vistaBrasil();
    controls.minDistance = 1.5; controls.maxDistance = b.r * 1.6;
    voo = null; controls.enabled = true;
    aplicarVista(foco ? vistaEstado(foco.uf) : b);
  };
  let sujo = true;

  // ---------- destaque do município clicado (borda grossa, sempre visível por cima) ----------
  const matDest = new LineMaterial({ color: 0xffffff, linewidth: 3, transparent: true, depthTest: false });
  const matGlow = new LineMaterial({ color: 0x8fb6ff, linewidth: 11, transparent: true, opacity: 0.35, depthTest: false });
  let destaque = null;
  const destacar = (m) => {
    if (destaque) { scene.remove(destaque.g); destaque.geo.dispose(); destaque = null; }
    sujo = true;
    if (m == null || m < 0) return;
    const seg = [];
    for (const aneis of pts[m]) for (const r of aneis) for (let i = 0; i < r.length; i++) {
      const [x1, z1] = r[i], [x2, z2] = r[(i + 1) % r.length];
      seg.push(x1, 0, z1, x2, 0, z2);
    }
    const geo = new LineSegmentsGeometry().setPositions(seg);
    const g = new THREE.Group();
    const brilho = new LineSegments2(geo, matGlow), borda = new LineSegments2(geo, matDest);
    brilho.renderOrder = 20; borda.renderOrder = 21;
    g.add(brilho, borda); scene.add(g);
    destaque = { m, g, geo, t0: performance.now() };
  };

  new ResizeObserver(enquadrar).observe(el);
  controls.addEventListener('change', () => { sujo = true; });

  // ---------- picking na GPU (1 pixel, só quando o mouse se move) ----------
  const matPick = new THREE.ShaderMaterial({
    uniforms, toneMapped: false,
    vertexShader: `${SHADER_TOPO} varying float vId;
      void main() { vec3 p = position; if (aKind < 1.5) p.y = alturaMuni(); vId = aMuni + 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `varying float vId;
      void main() { float id = floor(vId + 0.5); gl_FragColor = vec4(mod(id, 256.0) / 255.0, floor(id / 256.0) / 255.0, 0.0, 1.0); }`,
  });
  const cenaPick = new THREE.Scene();
  const malhaPick = new THREE.Mesh(prismas, matPick); malhaPick.frustumCulled = false; cenaPick.add(malhaPick);
  const alvoPick = new THREE.WebGLRenderTarget(1, 1);
  const px = new Uint8Array(4);
  const pick = (x, y) => {
    camera.setViewOffset(w, h, Math.round(x), Math.round(y), 1, 1);
    renderer.setRenderTarget(alvoPick); renderer.setClearColor(0, 0); renderer.clear();
    renderer.render(cenaPick, camera);
    renderer.setRenderTarget(null); camera.clearViewOffset();
    renderer.readRenderTargetPixels(alvoPick, 0, 0, 1, 1, px);
    const id = px[0] + px[1] * 256;
    return id ? id - 1 : -1;
  };
  let mouse = null, arrastando = false, inicio = null;
  renderer.domElement.addEventListener('pointermove', (ev) => { const r = el.getBoundingClientRect(); mouse = { x: ev.clientX - r.left, y: ev.clientY - r.top, cx: ev.clientX, cy: ev.clientY }; });
  renderer.domElement.addEventListener('pointerleave', () => { mouse = null; uniforms.uHover.value = -1; sujo = true; aoPassar?.(null); });
  renderer.domElement.addEventListener('pointerdown', (ev) => { arrastando = true; inicio = [ev.clientX, ev.clientY]; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    arrastando = false;
    if (inicio && Math.hypot(ev.clientX - inicio[0], ev.clientY - inicio[1]) < 5) {
      const r = el.getBoundingClientRect(), m = pick(ev.clientX - r.left, ev.clientY - r.top);
      if (m >= 0) aoClicar?.(codigos[m]);
    }
  });

  // ---------- chamadas (cidades destacadas) ----------
  const camada = document.createElement('div'); camada.className = 'chamadas';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('chamadas-linhas');
  el.append(svg, camada);
  let chamadas = [];
  const altAtual = (m) => { const t = uniforms.uT.value; return altData[m * 4] + (altData[m * 4 + 1] - altData[m * 4]) * t; };
  const v3 = new THREE.Vector3();
  const posicionarChamadas = () => {
    const compacto = w < 900;
    camada.classList.toggle('compacto', compacto);
    const colunas = { e: [], d: [] };
    for (const c of chamadas) {
      const [x, z] = centro[c.m];
      v3.set(x, altAtual(c.m), z).project(camera);
      c.ax = (v3.x * 0.5 + 0.5) * w; c.ay = (-v3.y * 0.5 + 0.5) * h;
      c.visivel = v3.z < 1 && c.ax > 0 && c.ax < w && c.ay > 0 && c.ay < h;
      c.alt = c.el.offsetHeight; c.larg = c.el.offsetWidth;
      if (c.visivel) colunas[c.lado].push(c);
    }
    const margem = 14, gap = 8;
    for (const [lado, lista] of Object.entries(colunas)) {
      lista.sort((a, b) => a.ay - b.ay);
      let y = margem;
      for (const c of lista) { c.y = Math.max(y, c.ay - c.alt / 2); y = c.y + c.alt + gap; }
      let teto = h - margem; // empurra para cima se estourou embaixo
      for (const c of [...lista].reverse()) { if (c.y + c.alt > teto) c.y = teto - c.alt; teto = c.y - gap; }
      for (const c of lista) c.x = lado === 'e' ? margem : w - margem - c.larg;
    }
    let caminhos = '';
    for (const c of chamadas) {
      c.el.style.display = c.visivel ? '' : 'none';
      if (!c.visivel) continue;
      if (compacto) { const x = c.ax > w * 0.6 ? c.ax - 8 - c.larg : c.ax + 8; c.el.style.transform = `translate(${x}px, ${c.ay - c.alt / 2}px)`; }
      else {
        c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
        const bx = c.lado === 'e' ? c.x + c.larg : c.x, by = c.y + Math.min(22, c.alt / 2);
        const ex = bx + (c.lado === 'e' ? 26 : -26);
        caminhos += `<path d="M${bx},${by} L${ex},${by} L${c.ax},${c.ay}"/>`;
      }
      caminhos += `<circle class="anel" cx="${c.ax}" cy="${c.ay}" r="6"/><circle cx="${c.ax}" cy="${c.ay}" r="2.6"/>`;
    }
    svg.innerHTML = caminhos;
  };

  // ---------- botão com o nome do estado, ancorado acima da borda norte dele (só no foco) ----------
  const btnUf = Object.assign(document.createElement('button'), { type: 'button', className: 'rotulo-uf', hidden: true });
  btnUf.addEventListener('click', () => aoClicarEstado?.());
  el.append(btnUf);
  const posicionarBotaoUf = () => {
    btnUf.hidden = !foco;
    if (!foco) return;
    btnUf.classList.toggle('ativo', !destaque); // estado selecionado = nenhuma cidade com borda
    const [x0, x1, z0] = caixas.get(foco.uf);
    v3.set((x0 + x1) / 2, alturaMediaUf(foco.uf), z0).project(camera);
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
    btnUf.style.transform = `translate(${x}px, ${Math.max(44, y - 12)}px) translate(-50%, -100%)`;
  };

  // ---------- rótulos geográficos discretos ----------
  const rotulos = [['OCEANO ATLÂNTICO', -41, 3.2]].map(([t, lon, lat]) => {
    const d = document.createElement('div'); d.className = 'rotulo-mar'; d.textContent = t; el.append(d);
    return { d, p: projetar(lon, lat) };
  });

  // ---------- animação ----------
  let anim = null;
  const loop = (agora) => {
    requestAnimationFrame(loop);
    if (voo) passoVoo(agora);
    else if (controls.update()) sujo = true;
    const dimAlvo = foco ? 0.84 : 0;
    if (uniforms.uDim.value !== dimAlvo) {
      const d = dimAlvo - uniforms.uDim.value;
      uniforms.uDim.value = Math.abs(d) < 0.01 ? dimAlvo : uniforms.uDim.value + d * 0.12;
      if (!foco && uniforms.uDim.value === 0) uniforms.uFoco.value = -1;
      sujo = true;
    }
    if (destaque) {
      destaque.g.position.y = altAtual(destaque.m) + 0.01;
      const t = (agora - destaque.t0) / 1000;
      if (t < 3) { const p = Math.abs(Math.sin(t * Math.PI * 1.2)); matGlow.opacity = 0.2 + 0.5 * p; matGlow.linewidth = 8 + 8 * p; sujo = true; }
      else if (matGlow.linewidth !== 11) { matGlow.opacity = 0.35; matGlow.linewidth = 11; sujo = true; }
    }
    if (anim) {
      const t = Math.min(1, (agora - anim.t0) / 1100);
      uniforms.uT.value = 1 - (1 - t) ** 3; sujo = true;
      if (t >= 1) anim = null;
    }
    if (mouse && !arrastando) {
      const m = pick(mouse.x, mouse.y);
      if (m !== uniforms.uHover.value) { uniforms.uHover.value = m; sujo = true; }
      aoPassar?.(m >= 0 ? codigos[m] : null, mouse.cx, mouse.cy);
      mouse = null;
    }
    if (!sujo) return;
    sujo = false;
    renderer.render(scene, camera);
    posicionarChamadas();
    posicionarBotaoUf();
    for (const r of rotulos) {
      r.d.style.display = foco ? 'none' : '';
      v3.set(r.p[0], 0, r.p[1]).project(camera);
      r.d.style.transform = `translate(${(v3.x * 0.5 + 0.5) * w}px, ${(-v3.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
    }
    if (bussola) bussola.style.transform = `rotate(${(-controls.getAzimuthalAngle() * 180) / Math.PI}deg)`;
  };
  enquadrar();
  requestAnimationFrame(loop);

  const tmp = new THREE.Color();
  return {
    tem: (ibge) => indice.has(ibge),
    /** Voa até o estado do município `ibge` e escurece os demais estados. `destacar`: borda no município. */
    focar(ibge, { destacar: comBorda = false, nomeEstado = '' } = {}) {
      const m = indice.get(ibge);
      if (m == null) return;
      foco = { uf: codigos[m].slice(0, 2) };
      btnUf.textContent = nomeEstado;
      uniforms.uFoco.value = Number(foco.uf);
      destacar(comBorda ? m : -1);
      voarPara(vistaEstado(foco.uf));
    },
    /** Borda de destaque num município (null remove). */
    destacar: (ibge) => destacar(ibge ? indice.get(ibge) ?? -1 : -1),
    /** Volta à visão do Brasil inteiro. */
    brasil() { foco = null; destacar(-1); voarPara(vistaBrasil()); },
    atualizar(dados) {
      const t = uniforms.uT.value;
      for (let i = 0; i < N; i++) {
        const d = dados.get(codigos[i]);
        const atual = altData[i * 4] + (altData[i * 4 + 1] - altData[i * 4]) * t;
        altData[i * 4] = atual;
        altData[i * 4 + 1] = d ? alturaDe(d.apuracao) : ALT_MIN;
        tmp.set(d?.cor ?? COR_SEM_DADOS);
        corData[i * 4] = tmp.r; corData[i * 4 + 1] = tmp.g; corData[i * 4 + 2] = tmp.b;
      }
      texAlt.needsUpdate = texCor.needsUpdate = true;
      uniforms.uT.value = 0; anim = { t0: performance.now() }; sujo = true;
    },
    /** lista: [{ ibge, lado: 'e' | 'd', html }] */
    destaques(lista) {
      const ant = new Map(chamadas.map((c) => [c.ibge, c]));
      chamadas = lista.filter((d) => indice.has(d.ibge)).map((d) => {
        const c = ant.get(d.ibge) ?? { ibge: d.ibge, m: indice.get(d.ibge), el: Object.assign(document.createElement('div'), { className: 'chamada' }) };
        c.lado = d.lado; c.el.innerHTML = d.html;
        camada.append(c.el); ant.delete(d.ibge);
        return c;
      });
      for (const c of ant.values()) c.el.remove();
      sujo = true;
    },
  };
}
