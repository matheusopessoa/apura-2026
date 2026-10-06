# Painel Eleições 2026 · Apuração em tempo real

Central de apuração da eleição presidencial de 2026 (e de Governador de Pernambuco), com **mapa 3D por município**, **projeção do resultado final** enquanto as urnas ainda estão sendo apuradas e **histórico gravado minuto a minuto**.

> Projeto **de código aberto**, *vibe-codado* rapidamente em cima do boilerplate **prixfy-bedrock**, durante a apuração do 1º turno. Feito para acompanhar a noite da eleição com mais contexto do que os números crus.

Os dados vêm da API pública de resultados do TSE (`resultados.tse.jus.br`). **Este não é um produto oficial do TSE.** Projeções e cenários são estimativas, não previsões oficiais.

---

## O que ele faz

### 🗺️ Mapa 3D por município
- **5.570 municípios**, cada um extrudado a partir do seu polígono real (malha oficial do IBGE).
- **Cor = quem lidera no município** · **altura = quanto já foi apurado no município**. As duas informações são independentes: num relance dá para ver quem está na frente e onde ainda falta apurar.
- O município é a unidade do mapa: nada é agregado por estado. Municípios vizinhos podem ter cor e altura diferentes.
- Iluminação, sombras e transições de altura animadas (three.js), com chamadas para as principais capitais.
- **Foco por estado e por cidade:**
  - clique numa cidade e a câmera voa até o estado dela, com a cidade destacada por uma borda;
  - o painel lateral mostra a cidade comparada com o **resto do estado** e com o **Brasil**;
  - clique de novo na cidade, ou no nome do estado sobre o mapa, para ver o estado comparado com a **região** e com o **Brasil**.

### 📈 Projeção do resultado final
- Leva cada estado a 100% do seu eleitorado, mantendo os percentuais atuais dele, e recalcula o total pelo peso de cada estado.
- **Situação garantida matematicamente:** avisa quando alguém já está eleito ou quando o 2º turno já é certo, mesmo que todos os votos restantes fossem para o outro lado.
- **Cenários editáveis:** "e se Lula melhorar X nos votos que faltam?", por região.
- **Projeção do 2º turno a partir do 1º:** distribui os eleitores da terceira via pelas taxas de transferência de uma pesquisa (editáveis), com um cenário realista e um pessimista, por região e por estado.

### 🎯 Previsão calibrada para o 2º turno
- O servidor gravou o 1º turno inteiro. Agora que o resultado final é conhecido, dá para medir **quanto a projeção errou em cada momento**.
- A projeção simples subestimou Lula do começo ao fim (−1,6 p.p. com 29% apurado), porque as últimas urnas de cada estado tendiam a favorecê-lo.
- Com isso, cada estado ganha uma **curva de correção** (quanto o resultado ainda mudou a partir de cada % de apuração), que é aplicada à projeção do 2º turno.
- O painel mostra a projeção simples e a calibrada lado a lado.

### 🕘 Histórico e replay
- Um snapshot do resultado a cada 30 s, gravado pelo servidor mesmo com o navegador fechado.
- Linha do tempo por percentil de apuração: o que a projeção dizia com 30%, 50%, 80%… e quanto ela errou em relação ao final.
- Exportação em CSV.
- No 2º turno, grava também **a apuração de cada município** a cada atualização do TSE, para reproduzir a noite no mapa depois.

### 🏛️ Governador de Pernambuco
- Página própria com apuração por município, projeção, gráficos e tabela pesquisável.

---

## Por que não usar só o site / app do TSE?

O site e o app **Resultados** do TSE são a fonte oficial e mostram o resultado apurado **naquele momento**. Este painel usa os mesmos dados públicos e acrescenta o que eles não oferecem:

| | Site / app do TSE | Este painel |
|---|---|---|
| Resultado oficial apurado | ✅ | ✅ (mesma fonte) |
| Mapa por município mostrando, ao mesmo tempo, líder **e** % apurado | — | ✅ mapa 3D |
| Projeção do resultado com 100% apurado | — | ✅ por estado, região e Brasil |
| Aviso de resultado matematicamente garantido | — | ✅ |
| Correção da projeção com o erro medido no 1º turno | — | ✅ |
| Histórico da apuração ao longo da noite | — (mostra o momento atual) | ✅ gravado a cada 30 s, com CSV |
| Comparação cidade × resto do estado × Brasil | — | ✅ |
| Cenários e transferência de votos para o 2º turno | — | ✅ editáveis |

---

## Como rodar

Requisitos: **Node.js 18+**. Não há dependências para instalar.

```bash
npm start
```

Abra:
- http://localhost:3000/presidente — painel com o mapa 3D
- http://localhost:3000/historico.html — histórico, erro da projeção e calibração
- http://localhost:3000/gov-pe — Governador de Pernambuco

Deixe o servidor rodando durante a apuração: é ele quem grava o histórico.

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `TURNO` | automático | `1` ou `2` força o turno. Sem ela, o servidor muda sozinho para o 2º turno quando o TSE começa a totalizá-lo |

---

## Como funciona

```
server.js            servidor HTTP sem dependências: proxy do TSE, gravação do histórico e APIs
public/
  index.html, app.js painel de Presidente (placar, mapa, projeções, cenários, tabelas)
  mapa3d.js          mapa 3D municipal (three.js): extrusão, iluminação, câmera, foco e destaque
  data.js            leitura da API do TSE (estados e municípios, 1º e 2º turno)
  calc.js            cálculos puros: agregação, projeção, situação garantida
  calibracao.js      curvas de correção aprendidas com o 1º turno
  historico.*        página de histórico
  gov-pe.*           página de Governador de PE
  geo/municipios.json  malha municipal do IBGE, compactada
scripts/gerar-geo.mjs  regenera a malha a partir da API do IBGE (npm run geo)
data/                  gravações (histórico, caches e replay municipal)
```

**APIs locais**

| Rota | Retorna |
|---|---|
| `/api/turno` | turno em andamento e código da eleição no TSE |
| `/api/historico?turno=1\|2` | snapshots por percentil de apuração |
| `/api/snapshot?i=N&turno=1\|2` | resultado por estado num momento gravado |
| `/api/historico.csv?turno=1\|2` | histórico em CSV |
| `/api/municipios` | resultado atual por município |
| `/api/municipios/replay` | momentos gravados por município (2º turno) |
| `/api/municipios/replay?i=N` | mapa municipal naquele momento |
| `/api/calibracao` | curvas de correção do 1º turno |
| `/tse/*` | proxy para `resultados.tse.jus.br/oficial` (cache de 15 s) |

**Cuidado com o TSE:** a API pública limita requisições (HTTP 429). O servidor relê os municípios só quando o TSE publica um arquivo novo, e só baixa os municípios que mudaram.

---

## Limitações conhecidas

- A calibração supõe que, dentro de cada estado, as urnas do 2º turno chegam numa ordem parecida com a do 1º. Com uma eleição só gravada, essa hipótese não pode ser testada; por isso a projeção simples continua visível.
- A gravação do 1º turno começou com 28% apurado; abaixo disso, a correção repete o primeiro valor conhecido de cada estado.
- **Boa Esperança do Norte (MT)**, criado em 2024, ainda não tem malha na API do IBGE e fica fora do mapa.
- Com a apuração encerrada, todos os municípios ficam em 100% e o mapa aparece com altura uniforme. É o dado real, não um defeito.

---

## Contribuindo

Issues e pull requests são bem-vindos. O código evita dependências e build: é só editar e recarregar a página.

Dados: [TSE · Resultados](https://resultados.tse.jus.br) · Malha municipal: [IBGE · API de Malhas](https://servicodados.ibge.gov.br/api/docs/malhas)

---

## Licença

[MIT](LICENSE)
