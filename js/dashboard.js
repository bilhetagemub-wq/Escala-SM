// ======================================================
// Escala São Miguel
// dashboard.js — plantão atual, próximos feriados e equipes
// ======================================================

import { montarLayout } from "./layout.js";
import {
    lerColecao, lerConfig, lerAjustesDoMes, ordenarEquipes, ROTULO_AUSENCIA, esc
} from "./dados.js";
import {
    gerarEscalaDoMes, integrantesDoDia, distribuirFeriados, sabadoDoFimDeSemana,
    somarDias, hojeISO, mesDe, NOMES_DIA, NOMES_DIA_CURTO, NOMES_MES, dataCurta, diaDaSemana
} from "./escala-engine.js";

montarLayout("dashboard");

const hora = new Date().getHours();
document.getElementById("saudacao").textContent =
    hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

async function iniciar() {
    const [equipesBrutas, funcionarios, feriados, config] = await Promise.all([
        lerColecao("equipes"), lerColecao("funcionarios"), lerColecao("feriados"), lerConfig()
    ]);
    const equipes = ordenarEquipes(equipesBrutas);
    const equipe = (id) => equipes.find((e) => e.id === id);

    renderEquipes(equipes, funcionarios);

    const plantao = document.getElementById("plantao");

    if (!equipes.length) {
        plantao.innerHTML = `
            <div class="vazio">
                <h3>Nenhuma equipe criada ainda</h3>
                <p>Monte as equipes de manutenção para a escala de fim de semana começar a funcionar.</p>
                <a class="bt bt-principal" href="/pages/funcionarios.html">Montar equipes</a>
            </div>`;
        renderFeriados([], equipe);
        return;
    }

    // Próximo plantão: fim de semana atual (ou o próximo) e feriado mais próximo, se vier antes
    const hoje = hojeISO();
    const sabado = sabadoDoFimDeSemana(hoje);
    const datas = [sabado, somarDias(sabado, 1)].filter((d) => d >= hoje);

    const distribuidos = distribuirFeriados(feriados, equipes, config);
    const feriadoAntes = distribuidos.find((f) => f.data >= hoje && f.data < datas[0]);
    if (feriadoAntes) datas.unshift(feriadoAntes.data);

    const meses = [...new Set(datas.map(mesDe))];
    const ajustesPorMes = Object.fromEntries(
        await Promise.all(meses.map(async (m) => [m, await lerAjustesDoMes(m)]))
    );
    const escalaPorMes = Object.fromEntries(meses.map((m) => [
        m, gerarEscalaDoMes(m, { equipes, feriados, config, ajustes: ajustesPorMes[m] })
    ]));

    const dias = datas
        .map((iso) => escalaPorMes[mesDe(iso)].find((d) => d.data === iso))
        .filter(Boolean);

    plantao.innerHTML = dias.map((d) => {
        const e = equipe(d.equipeId);
        const integrantes = integrantesDoDia(d, funcionarios, ajustesPorMes[mesDe(d.data)]);
        const quando = d.data === hoje ? "Hoje" : d.data === somarDias(hoje, 1) ? "Amanhã" : cap(NOMES_DIA[d.diaSemana]);

        return `
            <article class="plantao-dia" style="--cor:${esc(e?.cor || "#8b93a1")}">
                <div class="plantao-data" aria-hidden="true">
                    <strong>${d.data.slice(8)}</strong>
                    <span>${NOMES_DIA_CURTO[d.diaSemana]} ${NOMES_MES[Number(d.data.slice(5, 7)) - 1].slice(0, 3)}</span>
                </div>
                <p class="plantao-quando">${quando}, ${dataCurta(d.data)}</p>
                <h2 class="plantao-equipe">${esc(e?.nome || "Sem equipe")}</h2>
                ${d.feriado ? `<p class="plantao-feriado">Feriado: ${esc(d.feriado.descricao)}</p>` : ""}
                <ul class="plantao-membros">
                    ${integrantes.map((i) => `<li class="${i.ausencia ? "ausente" : ""}" title="${i.ausencia ? ROTULO_AUSENCIA[i.ausencia] : ""}">${esc(i.nome)}</li>`).join("")
                        || `<li>Sem funcionários ativos</li>`}
                </ul>
            </article>`;
    }).join("");

    renderFeriados(distribuidos.filter((f) => f.data >= hoje).slice(0, 5), equipe);
}

function renderFeriados(lista, equipe) {
    const el = document.getElementById("proximosFeriados");
    el.innerHTML = lista.length
        ? lista.map((f) => {
            const e = equipe(f.equipeId);
            return `
                <li style="--cor:${esc(e?.cor || "#8b93a1")}">
                    <i class="vela" aria-hidden="true"></i>
                    <span class="principal">${esc(f.descricao)}<small>${dataCurta(f.data)}, ${NOMES_DIA[diaDaSemana(f.data)]}</small></span>
                    <span class="lado">${esc(e?.nome || "")}</span>
                </li>`;
        }).join("")
        : `<li><span class="texto-apoio">Nenhum feriado cadastrado pela frente.</span></li>`;
}

function renderEquipes(equipes, funcionarios) {
    const el = document.getElementById("listaEquipes");
    const semEquipe = funcionarios.filter((f) => f.status !== "Inativo" && !equipes.some((e) => e.id === f.equipeId)).length;

    el.innerHTML = equipes.map((e) => {
        const ativos = funcionarios.filter((f) => f.equipeId === e.id && f.status !== "Inativo").length;
        return `
            <li style="--cor:${esc(e.cor)}">
                <i class="vela" aria-hidden="true"></i>
                <span class="principal">${esc(e.nome)}</span>
                <span class="lado">${ativos} ${ativos === 1 ? "pessoa" : "pessoas"}</span>
            </li>`;
    }).join("") + (semEquipe
        ? `<li><span class="principal">Sem equipe<small>Ficam fora da escala até entrarem numa equipe</small></span><span class="lado">${semEquipe}</span></li>`
        : "");

    if (!equipes.length && !semEquipe) {
        el.innerHTML = `<li><span class="texto-apoio">Nenhuma equipe criada.</span></li>`;
    }
}

iniciar().catch((erro) => {
    console.error(erro);
    document.getElementById("plantao").innerHTML =
        `<div class="vazio"><h3>Não foi possível carregar o plantão</h3><p>Verifique a conexão e recarregue a página.</p></div>`;
});
