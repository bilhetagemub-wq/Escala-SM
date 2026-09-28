// ======================================================
// Escala São Miguel
// importacao.js — importar e exportar funcionários por planilha
// ======================================================
//
// Colunas: Nome | Matrícula | Equipe | Cargo | Escala | Fim de semana | Encarregado | Status
//
// Regras:
// - Reconhece quem já existe pela matrícula; sem matrícula, pelo nome.
// - Equipe (função) que não existe é criada.
// - Em quem já existe, célula em branco mantém o valor atual.
// - Nada é gravado antes da prévia ser confirmada.

import { db } from "./firebase.js";
import {
    TIPOS, tipoDoTexto, tipoDoFuncionario, turmaDoTexto, turmaDe, normalizar, proximaCor, esc, ehEncarregado
} from "./dados.js";

import {
    collection, doc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const ALIASES = {
    nome: ["nome", "nome completo", "funcionario", "colaborador"],
    matricula: ["matricula", "mat", "mat.", "registro", "re", "chapa"],
    equipe: ["equipe", "equipe (funcao)", "setor", "time"],
    funcaoComoEquipe: ["funcao"],
    cargo: ["cargo"],
    escala: ["escala", "turno", "tipo", "tipo de escala"],
    turma: ["fim de semana", "turma", "fds", "grupo", "fim de semana (a/b)"],
    encarregado: ["encarregado", "lider", "encarregado?"],
    status: ["status", "situacao"]
};

const SIM = ["sim", "s", "x", "1", "yes"];
const NAO = ["nao", "n", "0", "no"];

const LIMITE_LOTE = 450; // Firestore aceita até 500 operações por lote

// ------------------------------------------------------
// Leitura do arquivo
// ------------------------------------------------------

async function lerArquivo(arquivo) {
    if (!window.XLSX) throw new Error("O leitor de planilhas não carregou. Recarregue a página.");

    const buffer = await arquivo.arrayBuffer();
    const livro = window.XLSX.read(buffer, { type: "array" });

    // prefere a aba "Funcionários"; senão, a primeira que não seja de instruções
    const nomeAba =
        livro.SheetNames.find((n) => normalizar(n) === "funcionarios") ||
        livro.SheetNames.find((n) => normalizar(n) !== "como preencher") ||
        livro.SheetNames[0];

    const linhas = window.XLSX.utils.sheet_to_json(livro.Sheets[nomeAba], {
        header: 1, defval: "", raw: false, blankrows: false
    });

    // procura a linha de cabeçalho nas 10 primeiras
    let idxCab = -1;
    for (let i = 0; i < Math.min(10, linhas.length); i++) {
        if (linhas[i].some((c) => ALIASES.nome.includes(normalizar(c)))) { idxCab = i; break; }
    }
    if (idxCab < 0) {
        throw new Error("Não encontrei a coluna Nome. Use o modelo ou confira se a primeira linha tem os títulos das colunas.");
    }

    const cab = linhas[idxCab].map(normalizar);
    const coluna = {};
    for (const [campo, nomes] of Object.entries(ALIASES)) {
        coluna[campo] = cab.findIndex((c) => nomes.includes(c));
    }
    // "Função" é a equipe quando não há coluna Equipe; havendo as duas, Função é o cargo
    if (coluna.equipe < 0) coluna.equipe = coluna.funcaoComoEquipe;
    else if (coluna.cargo < 0) coluna.cargo = coluna.funcaoComoEquipe;

    const valor = (linha, campo) =>
        coluna[campo] >= 0 ? String(linha[coluna[campo]] ?? "").replace(/\s+/g, " ").trim() : "";

    const registros = [];
    for (let i = idxCab + 1; i < linhas.length; i++) {
        const l = linhas[i];
        if (!l.some((c) => String(c).trim())) continue;
        registros.push({
            linha: i + 1,
            nome: valor(l, "nome"),
            matricula: valor(l, "matricula"),
            equipe: valor(l, "equipe"),
            cargo: valor(l, "cargo"),
            escala: valor(l, "escala"),
            turma: valor(l, "turma"),
            encarregado: valor(l, "encarregado"),
            status: valor(l, "status")
        });
    }

    return { aba: nomeAba, registros, semColunaEscala: coluna.escala < 0 };
}

// ------------------------------------------------------
// Análise (o que vai acontecer com cada linha)
// ------------------------------------------------------

function analisar(registros, equipes, funcionarios) {
    const porMatricula = new Map();
    const porNome = new Map();
    funcionarios.forEach((f) => {
        if (f.matricula) porMatricula.set(normalizar(f.matricula), f);
        const n = normalizar(f.nome);
        porNome.set(n, porNome.has(n) ? null : f); // null = nome repetido no sistema
    });

    const equipePorNome = new Map(equipes.map((e) => [normalizar(e.nome), e]));
    const novasEquipes = new Map();
    const matriculasVistas = new Map();
    const tocados = new Set();

    const itens = registros.map((r) => {
        const erros = [];
        const tipoInformado = tipoDoTexto(r.escala);
        const turmaInformada = turmaDoTexto(r.turma);
        const statusN = normalizar(r.status);
        const encN = normalizar(r.encarregado);

        if (!r.nome) erros.push("Nome em branco");
        if (r.escala && !tipoInformado) erros.push(`Escala "${r.escala}" inválida: use Diurna ou Noturna`);
        if (r.turma && !turmaInformada) erros.push(`Fim de semana "${r.turma}" inválido: use A ou B`);
        if (statusN && !["ativo", "inativo"].includes(statusN)) erros.push(`Status "${r.status}" inválido: use Ativo ou Inativo`);
        if (encN && !SIM.includes(encN) && !NAO.includes(encN)) erros.push(`Encarregado "${r.encarregado}" inválido: use Sim ou Não`);

        const matN = normalizar(r.matricula);
        if (matN) {
            if (matriculasVistas.has(matN)) erros.push(`Matrícula repetida (linha ${matriculasVistas.get(matN)})`);
            else matriculasVistas.set(matN, r.linha);
        }

        // quem já existe
        let existente = matN ? porMatricula.get(matN) : null;
        if (!existente && r.nome) {
            const pn = porNome.get(normalizar(r.nome));
            if (pn && (!pn.matricula || !matN)) existente = pn;
        }
        if (existente && tocados.has(existente.id)) {
            erros.push("Mesma pessoa aparece em outra linha");
            existente = null;
        }

        const tipo = tipoInformado || (existente ? tipoDoFuncionario(existente) : null);
        if (!tipo && !erros.length) erros.push("Escala em branco: informe Diurna ou Noturna");

        if (erros.length) return { ...r, erros, acao: "erro" };
        if (existente) tocados.add(existente.id);

        // equipe (função)
        let equipeId = existente?.equipeId || null;
        let equipeNova = null;
        let equipeNome = equipes.find((e) => e.id === equipeId)?.nome || "";
        if (r.equipe) {
            const chave = normalizar(r.equipe);
            const achada = equipePorNome.get(chave);
            if (achada) {
                equipeId = achada.id;
                equipeNome = achada.nome;
            } else {
                if (!novasEquipes.has(chave)) novasEquipes.set(chave, { chave, nome: r.equipe });
                equipeId = null;
                equipeNova = chave;
                equipeNome = r.equipe;
            }
        }

        const cargo = r.cargo || existente?.funcao || "";
        let lider;
        if (SIM.includes(encN)) lider = true;
        else if (NAO.includes(encN)) lider = false;
        else if (normalizar(r.cargo).includes("encarregad") || normalizar(r.equipe).includes("encarregad")) lider = true;
        else lider = existente ? ehEncarregado(existente, equipes) : false;

        const dados = {
            nome: r.nome,
            matricula: r.matricula || existente?.matricula || "",
            funcao: cargo,
            turno: TIPOS[tipo].turno,
            turma: turmaInformada || (existente ? turmaDe(existente) : null),
            status: statusN === "inativo" ? "Inativo" : statusN === "ativo" ? "Ativo" : (existente?.status || "Ativo"),
            lider
        };

        let acao = "novo";
        const mudancas = [];
        if (existente) {
            if (existente.nome !== dados.nome) mudancas.push("nome");
            if ((existente.matricula || "") !== dados.matricula) mudancas.push("matrícula");
            if ((existente.funcao || "") !== dados.funcao) mudancas.push("cargo");
            if (tipoDoFuncionario(existente) !== tipo) mudancas.push("escala");
            if (turmaDe(existente) !== dados.turma) mudancas.push(dados.turma ? `vai para o fim de semana ${dados.turma}` : "fim de semana");
            if ((existente.status || "Ativo") !== dados.status) mudancas.push("status");
            if (equipeNova || (existente.equipeId || null) !== equipeId) mudancas.push("equipe");
            if (ehEncarregado(existente, equipes) !== lider) mudancas.push(lider ? "vira encarregado" : "deixa de ser encarregado");
            acao = mudancas.length ? "atualiza" : "igual";
        }

        return { ...r, tipo, dados, existente, equipeId, equipeNova, equipeNome, acao, mudancas, erros: [] };
    });

    const conta = (a) => itens.filter((i) => i.acao === a).length;
    return {
        itens,
        novasEquipes: [...novasEquipes.values()],
        tocados,
        contagem: { novo: conta("novo"), atualiza: conta("atualiza"), igual: conta("igual"), erro: conta("erro") }
    };
}

// ------------------------------------------------------
// Gravação
// ------------------------------------------------------

async function aplicar(analise, equipes, funcionarios, inativarAusentes) {
    const ops = [];

    // equipes novas: id gerado antes, entram no fim da lista
    const idDaNova = new Map();
    const todas = [...equipes];
    let ordem = equipes.length ? Math.max(...equipes.map((e) => e.ordem ?? 0)) + 1 : 0;
    analise.novasEquipes.forEach((n) => {
        const ref = doc(collection(db, "equipes"));
        const dados = { nome: n.nome, cor: proximaCor(todas), ordem: ordem++ };
        todas.push({ id: ref.id, ...dados });
        idDaNova.set(n.chave, ref.id);
        ops.push({ ref, dados, tipo: "set" });
    });

    analise.itens.forEach((i) => {
        if (i.acao !== "novo" && i.acao !== "atualiza") return;
        const equipeId = i.equipeNova ? idDaNova.get(i.equipeNova) : i.equipeId;
        const dados = { ...i.dados, equipeId };
        if (i.acao === "novo") ops.push({ ref: doc(collection(db, "funcionarios")), dados, tipo: "set" });
        else ops.push({ ref: doc(db, "funcionarios", i.existente.id), dados, tipo: "update" });
    });

    let inativados = 0;
    if (inativarAusentes) {
        funcionarios.forEach((f) => {
            if (!analise.tocados.has(f.id) && f.status !== "Inativo") {
                ops.push({ ref: doc(db, "funcionarios", f.id), dados: { status: "Inativo" }, tipo: "update" });
                inativados++;
            }
        });
    }

    for (let i = 0; i < ops.length; i += LIMITE_LOTE) {
        const lote = writeBatch(db);
        ops.slice(i, i + LIMITE_LOTE).forEach((o) =>
            o.tipo === "set" ? lote.set(o.ref, o.dados) : lote.update(o.ref, o.dados)
        );
        await lote.commit();
    }

    return { inativados };
}

// ------------------------------------------------------
// Exportar planilha atual (mesmo formato do modelo)
// ------------------------------------------------------

export function exportarPlanilha(equipes, funcionarios) {
    if (!window.XLSX) throw new Error("O gerador de planilhas não carregou. Recarregue a página.");

    const posEquipe = new Map(equipes.map((e, i) => [e.id, i]));
    const nomeEquipe = (id) => equipes.find((e) => e.id === id)?.nome || "";

    const ordenados = [...funcionarios].sort((a, b) =>
        tipoDoFuncionario(a).localeCompare(tipoDoFuncionario(b)) ||
        (turmaDe(a) || "Z").localeCompare(turmaDe(b) || "Z") ||
        (posEquipe.get(a.equipeId) ?? 999) - (posEquipe.get(b.equipeId) ?? 999) ||
        (a.nome || "").localeCompare(b.nome || "")
    );

    const linhas = [
        ["Nome", "Matrícula", "Equipe", "Cargo", "Escala", "Fim de semana", "Encarregado", "Status"],
        ...ordenados.map((f) => [
            f.nome || "",
            f.matricula || "",
            nomeEquipe(f.equipeId),
            f.funcao || "",
            TIPOS[tipoDoFuncionario(f)].curto,
            turmaDe(f) || "",
            ehEncarregado(f, equipes) ? "Sim" : "Não",
            f.status || "Ativo"
        ])
    ];

    const aba = window.XLSX.utils.aoa_to_sheet(linhas);
    aba["!cols"] = [{ wch: 34 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 11 }, { wch: 14 }, { wch: 13 }, { wch: 10 }];
    // matrícula como texto, para não perder zeros à esquerda
    for (let r = 1; r < linhas.length; r++) {
        const cel = aba[window.XLSX.utils.encode_cell({ r, c: 1 })];
        if (cel) { cel.t = "s"; cel.z = "@"; }
    }

    const livro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(livro, aba, "Funcionários");

    const h = new Date();
    const data = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}-${String(h.getDate()).padStart(2, "0")}`;
    window.XLSX.writeFile(livro, `equipes-sao-miguel-${data}.xlsx`);
    return ordenados.length;
}

// ------------------------------------------------------
// Interface do modal
// ------------------------------------------------------

export function iniciarImportacao({ obterDados, aviso, abrirModal, fecharModal }) {
    const $ = (id) => document.getElementById(id);
    const modal = $("modalImportar");
    const entrada = $("arquivoPlanilha");
    const area = $("areaSoltar");
    const btnConfirmar = $("btnConfirmarImportacao");
    let analiseAtual = null;

    function mostrarEtapa(etapa) {
        const previa = etapa === "previa";
        $("etapaArquivo").classList.toggle("hidden", previa);
        $("etapaPrevia").classList.toggle("hidden", !previa);
        $("btnOutroArquivo").classList.toggle("hidden", !previa);
        btnConfirmar.classList.toggle("hidden", !previa);
    }

    function abrir() {
        analiseAtual = null;
        entrada.value = "";
        $("inativarAusentes").checked = false;
        mostrarEtapa("arquivo");
        abrirModal(modal, area);
    }

    function renderPrevia(nomeArquivo, analise, aba) {
        const { contagem, novasEquipes, itens } = analise;
        const total = contagem.novo + contagem.atualiza;

        $("nomeArquivo").innerHTML =
            `<i class="fa-solid fa-file-excel" aria-hidden="true"></i> ${esc(nomeArquivo)} <span class="texto-apoio">(aba ${esc(aba)}, ${itens.length} linhas)</span>`;

        $("resumoImportacao").innerHTML = [
            `<span class="contador contador--novo">${contagem.novo} novos</span>`,
            `<span class="contador contador--atualiza">${contagem.atualiza} atualizados</span>`,
            `<span class="contador">${contagem.igual} sem mudança</span>`,
            contagem.erro ? `<span class="contador contador--erro">${contagem.erro} com erro, não serão importados</span>` : "",
            novasEquipes.length
                ? `<span class="contador contador--equipe">Equipes novas: ${novasEquipes.map((n) => esc(n.nome)).join(", ")}</span>`
                : ""
        ].join("");

        const ordemAcao = { erro: 0, novo: 1, atualiza: 2, igual: 3 };
        $("linhasImportacao").innerHTML = [...itens]
            .sort((a, b) => ordemAcao[a.acao] - ordemAcao[b.acao] || a.linha - b.linha)
            .map((i) => {
                const resultado = {
                    erro: () => `<span class="resultado resultado--erro">${esc(i.erros.join(". "))}</span>`,
                    novo: () => `<span class="resultado resultado--novo">Novo</span>`,
                    atualiza: () => `<span class="resultado resultado--atualiza">Atualiza<small>${esc((i.mudancas || []).join(", "))}</small></span>`,
                    igual: () => `<span class="resultado resultado--igual">Sem mudança</span>`
                }[i.acao]();
                return `
                    <tr class="${i.acao === "erro" ? "erro" : ""}">
                        <td>${i.linha}</td>
                        <td>${esc(i.nome) || "—"}</td>
                        <td>${esc(i.dados?.matricula ?? i.matricula)}</td>
                        <td>${i.tipo ? TIPOS[i.tipo].curto : esc(i.escala)}</td>
                        <td>${i.dados ? (i.dados.turma || "—") : esc(i.turma)}${i.dados?.lider ? ` <small title="Encarregado">★</small>` : ""}</td>
                        <td>${esc(i.equipeNome || (i.acao === "erro" ? i.equipe : "Sem equipe"))}${i.equipeNova ? " <small>(nova)</small>" : ""}</td>
                        <td>${resultado}</td>
                    </tr>`;
            }).join("");

        btnConfirmar.disabled = total === 0 && !$("inativarAusentes").checked;
        btnConfirmar.textContent = total
            ? `Importar ${total} ${total === 1 ? "alteração" : "alterações"}`
            : "Nada para importar";
        mostrarEtapa("previa");
    }

    async function processar(arquivo) {
        if (!arquivo) return;
        if (!/\.(xlsx|xls|csv)$/i.test(arquivo.name)) {
            aviso("Envie um arquivo .xlsx, .xls ou .csv.", "erro");
            return;
        }
        try {
            const { aba, registros, semColunaEscala } = await lerArquivo(arquivo);
            if (!registros.length) {
                aviso("A planilha não tem linhas preenchidas abaixo do cabeçalho.", "erro");
                return;
            }
            const { equipes, funcionarios } = obterDados();
            analiseAtual = analisar(registros, equipes, funcionarios);
            renderPrevia(arquivo.name, analiseAtual, aba);
            if (semColunaEscala) aviso("A planilha não tem a coluna Escala. Novos funcionários precisam dela.", "erro");
        } catch (erro) {
            console.error(erro);
            aviso(erro.message || "Não foi possível ler a planilha.", "erro");
        }
    }

    entrada.addEventListener("change", () => processar(entrada.files[0]));

    ["dragenter", "dragover"].forEach((ev) => area.addEventListener(ev, (e) => {
        e.preventDefault();
        area.classList.add("arrastando");
    }));
    ["dragleave", "drop"].forEach((ev) => area.addEventListener(ev, (e) => {
        e.preventDefault();
        area.classList.remove("arrastando");
    }));
    area.addEventListener("drop", (e) => processar(e.dataTransfer.files[0]));

    $("btnOutroArquivo").addEventListener("click", () => {
        entrada.value = "";
        mostrarEtapa("arquivo");
    });

    $("inativarAusentes").addEventListener("change", () => {
        if (!analiseAtual) return;
        const { novo, atualiza } = analiseAtual.contagem;
        btnConfirmar.disabled = novo + atualiza === 0 && !$("inativarAusentes").checked;
        if (novo + atualiza === 0 && $("inativarAusentes").checked) btnConfirmar.textContent = "Inativar ausentes";
    });

    btnConfirmar.addEventListener("click", async () => {
        if (!analiseAtual) return;
        const inativar = $("inativarAusentes").checked;
        const { equipes, funcionarios } = obterDados();

        if (inativar) {
            const ausentes = funcionarios.filter((f) => !analiseAtual.tocados.has(f.id) && f.status !== "Inativo").length;
            if (ausentes && !confirm(`${ausentes} funcionários que não estão na planilha serão marcados como inativos. Continuar?`)) return;
        }

        btnConfirmar.disabled = true;
        btnConfirmar.textContent = "Importando…";
        try {
            const { inativados } = await aplicar(analiseAtual, equipes, funcionarios, inativar);
            const { novo, atualiza } = analiseAtual.contagem;
            const partes = [
                novo && `${novo} ${novo === 1 ? "novo" : "novos"}`,
                atualiza && `${atualiza} ${atualiza === 1 ? "atualizado" : "atualizados"}`,
                analiseAtual.novasEquipes.length && `${analiseAtual.novasEquipes.length} ${analiseAtual.novasEquipes.length === 1 ? "equipe criada" : "equipes criadas"}`,
                inativados && `${inativados} ${inativados === 1 ? "inativado" : "inativados"}`
            ].filter(Boolean);
            aviso(`Planilha importada: ${partes.join(", ") || "nenhuma alteração"}.`);
            fecharModal(modal);
        } catch (erro) {
            console.error(erro);
            aviso("A importação falhou no meio. Confira a conexão e importe a planilha de novo: quem já foi gravado aparece como sem mudança.", "erro");
            btnConfirmar.disabled = false;
            btnConfirmar.textContent = "Tentar de novo";
        }
    });

    return { abrir };
}

// exposto para testes
export const _interno = { analisar };
